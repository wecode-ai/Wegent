# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wiki.js 2.x connector (GraphQL, Bearer API key).

Wiki.js has no tree API: hierarchy is implied by the page path, so list
results are filtered by path prefix client-side and `pages.list` does not
support offset (we slice client-side under the bounded limit).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any
from urllib.parse import urlparse

import aiohttp

from app.core.async_utils import AsyncSessionManager
from app.core.config import settings
from app.services.plugin_upstream_fetch import (
    UpstreamFetchError,
    _assert_public_host,
)
from app.services.wiki.connector import (
    WikiApiError,
    WikiConnectionTest,
    WikiConnector,
    WikiPage,
    WikiPageMeta,
    WikiPageProbe,
    WikiSiteConfig,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

_LIST_QUERY = """
query ($limit: Int, $locale: String) {
  pages {
    list(
      limit: $limit
      orderBy: UPDATED
      orderByDirection: DESC
      locale: $locale
    ) {
      id path title description isPublished isPrivate updatedAt tags locale
    }
  }
}
"""

_PAGE_META_BY_ID_QUERY = """
query ($id: Int!) {
  pages {
    single(id: $id) {
      id path title description updatedAt locale
      tags { id tag title }
    }
  }
}
"""

_PAGE_BY_ID_QUERY = """
query ($id: Int!) {
  pages {
    single(id: $id) {
      id path title description updatedAt locale content render
      tags { id tag title }
    }
  }
}
"""

_PAGE_META_BY_PATH_QUERY = """
query ($path: String!, $locale: String!) {
  pages {
    singleByPath(path: $path, locale: $locale) {
      id path title description updatedAt locale
      tags { id tag title }
    }
  }
}
"""

# Field notes from the Wiki.js schema (server/graph/schemas/page.graphql):
# - Page.tags is [PageTag]! and needs a subfield selection (tags { id tag title })
# - Page.content requires the read:source scope; isPublished requires
#   write:pages / manage:system, so a read-only key must not select it
# - render is kept as an HTML fallback when content is not readable
_PAGE_QUERY = """
query ($path: String!, $locale: String!) {
  pages {
    singleByPath(path: $path, locale: $locale) {
      id path title description updatedAt locale content render
      tags { id tag title }
    }
  }
}
"""

_VERSION_QUERY = "query { system { info { currentVersion } } }"

# Site locales for singleByPath fallback (exact locale match required).
_LOCALES_QUERY = """
query { localization { locales { code isInstalled } } }
"""

_MAX_ATTEMPTS = 3  # initial call + 2 retries, 5xx/network errors only
WIKIJS_MIN_VERSION = (2, 5, 300)
WIKIJS_MIN_VERSION_LABEL = ".".join(str(part) for part in WIKIJS_MIN_VERSION)

_SITE_LOCALES_CACHE: dict[str, tuple[float, list[str]]] = {}
_SITE_LOCALES_CACHE_TTL_SECONDS = 60


def validate_wiki_site_url(url: str) -> str:
    """Validate a wiki site URL and return its normalized root form.

    Unlike ``validate_upstream_url`` this allows plain http because many
    self-hosted Wiki.js deployments are intranet-only. Private hosts are
    rejected unless the deployment opts in via WIKI_ALLOW_PRIVATE_NETWORK.
    """
    cleaned = url.strip()
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"}:
        raise WikiApiError("bad_request", "站点地址必须是 http(s) URL", retryable=False)
    if not parsed.hostname:
        raise WikiApiError("bad_request", "站点地址缺少主机名", retryable=False)
    if parsed.username or parsed.password:
        raise WikiApiError("bad_request", "站点地址不允许携带凭据", retryable=False)
    if not settings.WIKI_ALLOW_PRIVATE_NETWORK:
        # Reuses the platform host policy; performs blocking DNS resolution,
        # callers run it through asyncio.to_thread.
        try:
            _assert_public_host(parsed.hostname)
        except UpstreamFetchError as exc:
            raise WikiApiError(
                "bad_request",
                "站点地址不允许指向本机/内网地址；内网 Wiki 需部署开启 "
                "WIKI_ALLOW_PRIVATE_NETWORK",
            ) from exc
    return (
        parsed._replace(scheme=parsed.scheme.lower(), netloc=parsed.netloc.lower())
        .geturl()
        .rstrip("/")
    )


def _meta_from_node(node: dict[str, Any]) -> WikiPageMeta:
    # tags arrive as [String] from pages.list and as [{id, tag, title}] from
    # pages.singleByPath; accept both shapes.
    tags: list[str] = []
    for tag in node.get("tags") or ():
        if isinstance(tag, dict):
            tags.append(str(tag.get("tag") or tag.get("title") or ""))
        else:
            tags.append(str(tag))
    return WikiPageMeta(
        id=str(node.get("id", "")),
        path=str(node.get("path", "")),
        title=str(node.get("title") or node.get("path") or ""),
        description=str(node.get("description") or ""),
        updated_at=str(node.get("updatedAt") or ""),
        tags=tuple(tag for tag in tags if tag),
        locale=str(node.get("locale") or ""),
        is_published=bool(node.get("isPublished", True)),
        is_private=bool(node.get("isPrivate", False)),
    )


def _is_missing_page_error(exc: WikiApiError) -> bool:
    lowered = exc.message.lower()
    return exc.error_code == "wiki_page_not_found" or any(
        marker in lowered for marker in ("does not exist", "page not found")
    )


def _is_missing_page_message(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in ("does not exist", "page not found"))


def _is_forbidden_message(message: str) -> bool:
    lowered = message.lower()
    return any(
        marker in lowered
        for marker in (
            "forbidden",
            "not authenticated",
            "not authorized",
            "unauthorized",
        )
    )


def _parse_version(value: str | None) -> tuple[int, int, int] | None:
    """Parse the numeric Wiki.js release prefix without accepting other majors."""
    match = re.search(r"(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)", value or "")
    return tuple(int(part) for part in match.groups()) if match else None


def _extension_strings(value: Any) -> list[str]:
    if isinstance(value, dict):
        result: list[str] = []
        for child in value.values():
            result.extend(_extension_strings(child))
        return result
    if isinstance(value, (list, tuple)):
        result = []
        for child in value:
            result.extend(_extension_strings(child))
        return result
    return [str(value)] if isinstance(value, (str, int)) else []


def _classify_graphql_error(error: dict[str, Any]) -> str:
    """Map Wiki.js GraphQL error metadata to the stable connector contract."""
    message = str(error.get("message") or "")
    tokens = " ".join(_extension_strings(error.get("extensions"))).lower()
    combined = f"{tokens} {message.lower()}"
    if any(
        marker in combined
        for marker in (
            "pageviewforbidden",
            "page_view_forbidden",
            "not authorized to view this page",
        )
    ):
        return "wiki_page_forbidden"
    if any(
        marker in combined
        for marker in (
            "unauthenticated",
            "authenticationerror",
            "forbidden",
            "forbiddenerror",
            "unauthorized",
        )
    ) or _is_forbidden_message(message):
        return "wiki_auth_failed"
    if any(
        marker in combined for marker in ("pagenotfound", "page_not_found")
    ) or _is_missing_page_message(message):
        return "wiki_page_not_found"
    return "upstream_error"


class WikijsConnector(WikiConnector):
    """Wiki.js 2.x adapter over the GraphQL endpoint."""

    supports_scheduled_sync = True
    connector_type = "wikijs"
    display_name = "Wiki.js"

    async def _request_graphql(
        self,
        config: WikiSiteConfig,
        query: str,
        variables: dict[str, Any],
    ) -> dict[str, Any]:
        await asyncio.to_thread(validate_wiki_site_url, config.site_url)
        endpoint = f"{config.site_url.rstrip('/')}/graphql"
        headers = {
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
        }
        last_error: WikiApiError | None = None
        payload: dict[str, Any] = {}
        for attempt in range(_MAX_ATTEMPTS):
            try:
                async with AsyncSessionManager(
                    timeout=settings.WIKIJS_GRAPHQL_TIMEOUT_SECONDS
                ) as session:
                    async with session.post(
                        endpoint,
                        json={"query": query, "variables": variables},
                        headers=headers,
                    ) as response:
                        if response.status in (401, 403):
                            raise WikiApiError(
                                "wiki_auth_failed",
                                "Wiki 站点拒绝了 API Key（401/403），请检查 Key 是否有效",
                                retryable=False,
                            )
                        if response.status >= 500:
                            raise WikiApiError(
                                "wiki_unreachable",
                                f"Wiki 站点返回 {response.status}",
                                retryable=True,
                            )
                        if not 200 <= response.status < 300:
                            body = await response.text()
                            logger.warning(
                                "[WikijsConnector] GraphQL failed: status=%s",
                                response.status,
                            )
                            raise WikiApiError(
                                "upstream_error",
                                f"Wiki 站点返回 {response.status}: " f"{body[:200]}",
                                retryable=False,
                            )
                        payload = await response.json(content_type=None)
                break
            except WikiApiError as exc:
                if not exc.retryable or attempt == _MAX_ATTEMPTS - 1:
                    raise
                last_error = exc
                logger.warning(
                    "[WikijsConnector] Retryable error (attempt %s): %s",
                    attempt + 1,
                    exc.error_code,
                )
                await asyncio.sleep(0.5 * (attempt + 1))
            except asyncio.TimeoutError:
                last_error = WikiApiError("wiki_timeout", "访问 Wiki 站点超时")
                if attempt == _MAX_ATTEMPTS - 1:
                    raise last_error
                logger.warning(
                    "[WikijsConnector] Request timeout (attempt %s)", attempt + 1
                )
                await asyncio.sleep(0.5 * (attempt + 1))
            except aiohttp.ClientError:
                last_error = WikiApiError("wiki_unreachable", "无法连接 Wiki 站点")
                if attempt == _MAX_ATTEMPTS - 1:
                    raise last_error
                logger.warning(
                    "[WikijsConnector] Network error (attempt %s)", attempt + 1
                )
                await asyncio.sleep(0.5 * (attempt + 1))
        if not isinstance(payload, dict):
            raise WikiApiError(
                "upstream_error", "Wiki 站点返回了无法解析的响应", retryable=False
            )
        return payload

    async def _post_graphql(
        self,
        config: WikiSiteConfig,
        query: str,
        variables: dict[str, Any],
    ) -> dict[str, Any]:
        payload = await self._request_graphql(config, query, variables)
        errors = payload.get("errors")
        if errors:
            raw_error = errors[0] if isinstance(errors[0], dict) else {}
            first = str(raw_error.get("message", "unknown GraphQL error"))
            error_code = _classify_graphql_error(raw_error)
            if error_code in {"wiki_auth_failed", "wiki_page_forbidden"}:
                raise WikiApiError(
                    "wiki_auth_failed", f"Wiki 站点鉴权失败：{first}", retryable=False
                )
            raise WikiApiError(error_code, f"Wiki 站点返回错误：{first}")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise WikiApiError(
                "upstream_error", "Wiki 站点返回了无法解析的响应", retryable=False
            )
        return data

    async def test_connection(self, config: WikiSiteConfig) -> WikiConnectionTest:
        version = await self._probe_version(config)
        parsed_version = _parse_version(version)
        if parsed_version and (
            parsed_version[0] != WIKIJS_MIN_VERSION[0]
            or parsed_version < WIKIJS_MIN_VERSION
        ):
            return WikiConnectionTest(
                ok=False,
                message=(
                    f"不支持 Wiki.js {version}；当前仅支持 "
                    f"Wiki.js {WIKIJS_MIN_VERSION_LABEL} 及以上的 2.x 版本"
                ),
                version=version,
            )
        try:
            data = await self._post_graphql(
                config, _LIST_QUERY, {"limit": 1, "locale": None}
            )
        except WikiApiError as exc:
            return WikiConnectionTest(ok=False, message=exc.message)
        page_list = ((data.get("pages") or {}).get("list")) or []
        if not isinstance(page_list, list):
            return WikiConnectionTest(ok=False, message="Wiki 站点响应格式不符合预期")
        if page_list:
            first_page = page_list[0]
            try:
                metadata = await self.get_page_metadata_by_path(
                    config,
                    str(first_page.get("path") or ""),
                    str(first_page.get("locale") or "") or config.default_locale,
                )
                page = await self.get_page_by_id(
                    config, str(first_page.get("id") or "")
                )
            except WikiApiError as exc:
                return WikiConnectionTest(
                    ok=False,
                    message=(
                        "连接可用，但 API Key 无法完成页面路径解析与正文读取："
                        f"{exc.message}。请确认 Wiki.js 版本和 API Key 权限"
                    ),
                    version=version,
                )
            if metadata is None or page is None:
                return WikiConnectionTest(
                    ok=False,
                    message="Wiki API Key 无法完成页面路径解析与正文读取",
                    version=version,
                )
        elif version is None:
            return WikiConnectionTest(
                ok=False,
                message=(
                    "站点没有可测试页面且无法读取版本，不能确认是否满足 "
                    f"Wiki.js {WIKIJS_MIN_VERSION_LABEL}+ 2.x 兼容要求"
                ),
            )
        message = "连接成功" if page_list else "连接成功，但站点没有可测试的已发布页面"
        return WikiConnectionTest(ok=True, message=message, version=version)

    async def _probe_version(self, config: WikiSiteConfig) -> str | None:
        try:
            data = await self._post_graphql(config, _VERSION_QUERY, {})
        except WikiApiError:
            # system.info may require admin scope; version stays best-effort.
            return None
        info = ((data.get("system") or {}).get("info")) or {}
        version = info.get("currentVersion")
        return str(version) if version else None

    @trace_async(span_name="wikijs_list_pages", tracer_name="wiki.connector.wikijs")
    async def list_pages(
        self,
        config: WikiSiteConfig,
        *,
        path: str | None = None,
        locale: str | None = None,
        limit: int,
        offset: int = 0,
    ) -> tuple[list[WikiPageMeta], int | None]:
        effective_locale = locale or config.default_locale
        # pages.list has no server-side path filter and no offset: prefix
        # filtering happens client-side, so a subtree listing must fetch the
        # bounded full list first (fetching offset+limit pages would miss the
        # subtree entirely whenever recent updates live elsewhere).
        page_cap = settings.WIKI_TREE_MAX_PAGES
        fetch_limit = page_cap + 1 if path else min(offset + limit + 1, page_cap + 1)
        data = await self._post_graphql(
            config,
            _LIST_QUERY,
            {"limit": fetch_limit or 1, "locale": effective_locale},
        )
        nodes = ((data.get("pages") or {}).get("list")) or []
        if not isinstance(nodes, list):
            raise WikiApiError(
                "upstream_error", "Wiki 站点响应格式不符合预期", retryable=False
            )
        exceeded_page_cap = len(nodes) > page_cap
        metas = [_meta_from_node(node) for node in nodes[:page_cap]]
        metas = [
            meta
            for meta in metas
            if meta.is_published and not meta.is_private and meta.path
        ]
        if path:
            prefix = path.strip("/")
            metas = [
                meta
                for meta in metas
                if meta.path == prefix or meta.path.startswith(f"{prefix}/")
            ]
        batch = metas[offset : offset + limit]
        next_offset = offset + limit if len(metas) > offset + limit else None
        if exceeded_page_cap and next_offset is None:
            next_offset = page_cap
        return batch, next_offset

    @trace_async(
        span_name="wikijs_get_page_metadata_by_id",
        tracer_name="wiki.connector.wikijs",
    )
    async def get_page_metadata_by_id(
        self,
        config: WikiSiteConfig,
        resource_id: str,
    ) -> WikiPageMeta | None:
        try:
            page_id = int(resource_id)
        except (TypeError, ValueError) as exc:
            raise WikiApiError(
                "bad_request", "Wiki page id must be an integer", retryable=False
            ) from exc
        try:
            data = await self._post_graphql(
                config,
                _PAGE_META_BY_ID_QUERY,
                {"id": page_id},
            )
        except WikiApiError as exc:
            if _is_missing_page_error(exc):
                return None
            raise
        node = (data.get("pages") or {}).get("single")
        return _meta_from_node(node) if isinstance(node, dict) else None

    @trace_async(
        span_name="wikijs_get_page_metadata_by_path",
        tracer_name="wiki.connector.wikijs",
    )
    async def get_page_metadata_by_path(
        self,
        config: WikiSiteConfig,
        path: str,
        locale: str | None = None,
    ) -> WikiPageMeta | None:
        attempts = (
            [locale]
            if locale
            else list(
                dict.fromkeys(
                    [
                        *([config.default_locale] if config.default_locale else []),
                        *await self._installed_locales(config),
                    ]
                )
            )
        )
        for attempt_locale in attempts:
            try:
                data = await self._post_graphql(
                    config,
                    _PAGE_META_BY_PATH_QUERY,
                    {"path": path.strip("/"), "locale": attempt_locale},
                )
            except WikiApiError as exc:
                if _is_missing_page_error(exc):
                    continue
                raise
            node = (data.get("pages") or {}).get("singleByPath")
            if isinstance(node, dict):
                return _meta_from_node(node)
        return None

    @trace_async(
        span_name="wikijs_inspect_page_metadata_by_ids",
        tracer_name="wiki.connector.wikijs",
    )
    async def inspect_page_metadata_by_ids(
        self,
        config: WikiSiteConfig,
        resource_ids: list[str],
        *,
        batch_size: int,
    ) -> dict[str, WikiPageProbe]:
        unique_ids = list(dict.fromkeys(resource_ids))
        results: dict[str, WikiPageProbe] = {}
        size = max(1, batch_size)
        for start in range(0, len(unique_ids), size):
            batch = unique_ids[start : start + size]
            aliases: dict[str, str] = {}
            variables: dict[str, int] = {}
            fields: list[str] = []
            for index, resource_id in enumerate(batch):
                alias = f"p{index}"
                try:
                    page_id = int(resource_id)
                except (TypeError, ValueError):
                    results[resource_id] = WikiPageProbe(
                        error_code="bad_request",
                        error_message="Wiki 页面 ID 无效",
                    )
                    continue
                aliases[alias] = resource_id
                variables[f"id{index}"] = page_id
                fields.append(
                    f"{alias}: single(id: $id{index}) {{ "
                    "id path title description updatedAt locale "
                    "tags { id tag title } }"
                )
            if not fields:
                continue
            declarations = ", ".join(
                f"$id{index}: Int!"
                for index, resource_id in enumerate(batch)
                if resource_id not in results
            )
            query = f"query ({declarations}) {{ pages {{ {' '.join(fields)} }} }}"
            try:
                payload = await self._request_graphql(config, query, variables)
            except WikiApiError as exc:
                for resource_id in aliases.values():
                    results[resource_id] = WikiPageProbe(
                        error_code=exc.error_code,
                        error_message=exc.message,
                    )
                continue

            data = payload.get("data")
            pages = data.get("pages") if isinstance(data, dict) else None
            pages = pages if isinstance(pages, dict) else {}
            errors_by_alias: dict[str, tuple[str, str]] = {}
            global_error_code: str | None = None
            for raw_error in payload.get("errors") or []:
                if not isinstance(raw_error, dict):
                    continue
                path = raw_error.get("path")
                alias = next(
                    (
                        str(item)
                        for item in path or []
                        if isinstance(item, str) and item in aliases
                    ),
                    None,
                )
                if alias:
                    errors_by_alias[alias] = (
                        _classify_graphql_error(raw_error),
                        str(raw_error.get("message") or ""),
                    )
                else:
                    classified = _classify_graphql_error(raw_error)
                    global_error_code = (
                        "wiki_auth_failed"
                        if classified == "wiki_page_forbidden"
                        else classified
                    )

            for alias, resource_id in aliases.items():
                node = pages.get(alias)
                if isinstance(node, dict):
                    results[resource_id] = WikiPageProbe(page=_meta_from_node(node))
                    continue
                error = errors_by_alias.get(alias)
                error_code, message = error or (None, "")
                if error_code == "wiki_page_not_found":
                    results[resource_id] = WikiPageProbe(confirmed_missing=True)
                elif error_code in {"wiki_auth_failed", "wiki_page_forbidden"}:
                    results[resource_id] = WikiPageProbe(
                        error_code="wiki_page_forbidden",
                        error_message="无权访问 Wiki 源文档",
                    )
                elif error_code:
                    results[resource_id] = WikiPageProbe(
                        error_code=error_code,
                        error_message=message or None,
                    )
                elif (
                    alias in pages
                    and node is None
                    and not message
                    and not global_error_code
                ):
                    results[resource_id] = WikiPageProbe(confirmed_missing=True)
                else:
                    results[resource_id] = WikiPageProbe(
                        error_code=global_error_code or "wiki_batch_result_missing"
                    )
        return results

    async def _installed_locales(self, config: WikiSiteConfig) -> list[str]:
        """Resolve the site's installed locales (short process-local cache).

        singleByPath requires an exact locale match and Wiki.js reports a
        miss as a GraphQL error, so without an explicit/default locale we
        must know which locales to try.
        """
        now = time.monotonic()
        cached = _SITE_LOCALES_CACHE.get(config.site_url)
        if cached and now - cached[0] < _SITE_LOCALES_CACHE_TTL_SECONDS:
            return cached[1]
        try:
            data = await self._post_graphql(config, _LOCALES_QUERY, {})
            raw_locales = ((data.get("localization") or {}).get("locales")) or []
            codes = [
                str(item.get("code"))
                for item in raw_locales
                if isinstance(item, dict)
                and item.get("isInstalled")
                and item.get("code")
            ]
        except WikiApiError:
            codes = []
        if not codes:
            codes = ["en"]
        if (
            config.site_url not in _SITE_LOCALES_CACHE
            and len(_SITE_LOCALES_CACHE) >= 64
        ):
            oldest_key = min(
                _SITE_LOCALES_CACHE,
                key=lambda key: _SITE_LOCALES_CACHE[key][0],
            )
            _SITE_LOCALES_CACHE.pop(oldest_key, None)
        _SITE_LOCALES_CACHE[config.site_url] = (now, codes)
        return codes

    @trace_async(span_name="wikijs_get_page_by_id", tracer_name="wiki.connector.wikijs")
    async def get_page_by_id(
        self,
        config: WikiSiteConfig,
        resource_id: str,
    ) -> WikiPage | None:
        try:
            page_id = int(resource_id)
        except (TypeError, ValueError) as exc:
            raise WikiApiError(
                "bad_request", "Wiki page id must be an integer", retryable=False
            ) from exc
        try:
            data = await self._post_graphql(config, _PAGE_BY_ID_QUERY, {"id": page_id})
        except WikiApiError as exc:
            if _is_missing_page_error(exc):
                return None
            raise
        node = (data.get("pages") or {}).get("single")
        if not isinstance(node, dict):
            return None
        return WikiPage(
            **{
                **_meta_from_node(node).__dict__,
                "content": str(node.get("content") or ""),
            }
        )

    @trace_async(span_name="wikijs_get_page", tracer_name="wiki.connector.wikijs")
    async def get_page(
        self,
        config: WikiSiteConfig,
        path: str,
        locale: str | None = None,
    ) -> WikiPage | None:
        if locale:
            # An explicit locale is a strict request: one attempt only.
            attempts = [locale]
        else:
            # default_locale is a preference, not a filter: try it first,
            # then fall back to the site's other installed locales (pages
            # may exist in a different locale than the site default).
            preferred = [config.default_locale] if config.default_locale else []
            attempts = list(
                dict.fromkeys([*preferred, *await self._installed_locales(config)])
            )
        for attempt_locale in attempts:
            try:
                data = await self._post_graphql(
                    config,
                    _PAGE_QUERY,
                    {"path": path.strip("/"), "locale": attempt_locale},
                )
            except WikiApiError as exc:
                # Wiki.js reports a locale miss as a GraphQL error; try the
                # next installed locale before giving up.
                if _is_missing_page_error(exc):
                    continue
                raise
            node = (data.get("pages") or {}).get("singleByPath")
            if not isinstance(node, dict):
                return None
            return WikiPage(
                **{
                    **_meta_from_node(node).__dict__,
                    "content": str(node.get("content") or ""),
                }
            )
        return None
