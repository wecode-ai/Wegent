# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Small async GitLab REST client used only by external Wiki connectors."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Self
from urllib.parse import quote

import aiohttp

from app.core.async_utils import AsyncSessionManager
from app.core.config import settings
from app.services.wiki.connector import WikiApiError, WikiSiteConfig
from shared.utils.url_util import build_url

_MAX_ATTEMPTS = 3
_GITLAB_MAX_PAGE_SIZE = 100
_LEGACY_BASE64_LINE_LENGTH = 60
_MAX_JSON_STRING_EXPANSION = 6
GITLAB_WIKI_LIST_MAX_RESPONSE_BYTES = 32 * 1024 * 1024


@dataclass(frozen=True)
class GitLabPage:
    items: list[dict[str, Any]]
    next_offset: int | None = None


def canonical_resource_key(parts: list[str]) -> str:
    return json.dumps(parts, ensure_ascii=False, separators=(",", ":"))


class GitLabExternalWikiClient:
    """Bounded, redirect-safe GitLab API reader."""

    def __init__(self, config: WikiSiteConfig) -> None:
        self.site_url = config.site_url.rstrip("/")
        self.api_url = build_url(self.site_url, "/api/v4")
        self.headers = {"PRIVATE-TOKEN": config.api_key}
        self._session_manager: AsyncSessionManager | None = None
        self._session: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> Self:
        if self._session is not None:
            raise RuntimeError("GitLab client context is already active")
        manager = AsyncSessionManager(timeout=settings.REPOSITORY_READ_TIMEOUT_SECONDS)
        self._session = await manager.__aenter__()
        self._session_manager = manager
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: Any,
    ) -> None:
        manager = self._session_manager
        self._session = None
        self._session_manager = None
        if manager is not None:
            await manager.__aexit__(exc_type, exc_value, traceback)

    @asynccontextmanager
    async def _session_scope(self) -> AsyncIterator[aiohttp.ClientSession]:
        if self._session is not None:
            yield self._session
            return
        async with AsyncSessionManager(
            timeout=settings.REPOSITORY_READ_TIMEOUT_SECONDS
        ) as session:
            yield session

    @staticmethod
    def _project(project_path: str) -> str:
        return quote(project_path, safe="")

    @staticmethod
    def _path(path: str) -> str:
        return quote(path, safe="")

    @staticmethod
    def _next_offset(headers: Any, limit: int) -> int | None:
        raw = str(headers.get("X-Next-Page") or "").strip()
        return (int(raw) - 1) * limit if raw.isdigit() and int(raw) > 0 else None

    @staticmethod
    def _pagination(limit: int, offset: int) -> tuple[int, int]:
        page_size = min(max(1, limit), _GITLAB_MAX_PAGE_SIZE)
        return page_size, offset // page_size + 1

    @staticmethod
    def _download_timeout() -> aiohttp.ClientTimeout:
        total = settings.EXTERNAL_WIKI_DOWNLOAD_TIMEOUT_SECONDS
        return aiohttp.ClientTimeout(total=total, connect=min(10, total))

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        not_found_code: str = "external_source_missing",
        max_bytes: int | None = GITLAB_WIKI_LIST_MAX_RESPONSE_BYTES,
        response_too_large_code: str = "external_response_too_large",
        response_too_large_message: str = "GitLab API 响应过大",
        headers_only: bool = False,
        timeout: aiohttp.ClientTimeout | None = None,
        max_attempts: int = _MAX_ATTEMPTS,
    ) -> tuple[Any, Any]:
        url = build_url(self.api_url, path)
        request_params = (
            {key: value for key, value in params.items() if value is not None}
            if params
            else None
        )
        attempts = min(max(1, max_attempts), _MAX_ATTEMPTS)
        request_kwargs = {"timeout": timeout} if timeout is not None else {}
        last_error: WikiApiError | None = None
        for attempt in range(attempts):
            try:
                async with self._session_scope() as session:
                    async with session.request(
                        method,
                        url,
                        params=request_params,
                        headers=self.headers,
                        allow_redirects=False,
                        **request_kwargs,
                    ) as response:
                        if response.status in {301, 302, 303, 307, 308}:
                            raise WikiApiError(
                                "upstream_error",
                                "GitLab API 返回了不允许的重定向",
                                retryable=False,
                            )
                        if response.status == 401:
                            raise WikiApiError(
                                "wiki_auth_failed",
                                "GitLab AppKey 无效",
                                retryable=False,
                            )
                        if response.status == 403:
                            raise WikiApiError(
                                "wiki_page_forbidden",
                                "GitLab AppKey 无权访问该资源",
                                retryable=False,
                            )
                        if response.status == 404:
                            raise WikiApiError(
                                not_found_code,
                                "GitLab 资源不存在或不可访问",
                                retryable=False,
                            )
                        if response.status == 429:
                            retry_after = str(
                                response.headers.get("Retry-After") or ""
                            ).strip()
                            delay = (
                                min(float(retry_after), 30.0)
                                if retry_after.replace(".", "", 1).isdigit()
                                else 1.0
                            )
                            last_error = WikiApiError(
                                "external_rate_limited",
                                "GitLab API 请求过于频繁，请稍后重试",
                                retryable=True,
                            )
                            if attempt == attempts - 1:
                                raise last_error
                            await asyncio.sleep(delay)
                            continue
                        if response.status >= 500:
                            raise WikiApiError(
                                "upstream_error",
                                f"GitLab API 返回 {response.status}",
                                retryable=True,
                            )
                        if not 200 <= response.status < 300:
                            raise WikiApiError(
                                "upstream_error",
                                f"GitLab API 返回 {response.status}",
                                retryable=False,
                            )
                        if headers_only:
                            return None, response.headers
                        content_length = str(
                            response.headers.get("Content-Length") or ""
                        ).strip()
                        if (
                            max_bytes is not None
                            and content_length.isdigit()
                            and int(content_length) > max_bytes
                        ):
                            raise WikiApiError(
                                response_too_large_code,
                                response_too_large_message,
                                retryable=False,
                            )
                        body = bytearray()
                        async for chunk in response.content.iter_chunked(64 * 1024):
                            if (
                                max_bytes is not None
                                and len(body) + len(chunk) > max_bytes
                            ):
                                raise WikiApiError(
                                    response_too_large_code,
                                    response_too_large_message,
                                    retryable=False,
                                )
                            body.extend(chunk)
                        try:
                            return json.loads(body or b"null"), response.headers
                        except (TypeError, ValueError) as exc:
                            raise WikiApiError(
                                "upstream_error",
                                "GitLab API 返回了无法解析的响应",
                                retryable=False,
                            ) from exc
            except WikiApiError as exc:
                if not exc.retryable or attempt == attempts - 1:
                    raise
                last_error = exc
                await asyncio.sleep(0.5 * (attempt + 1))
            except asyncio.TimeoutError:
                last_error = WikiApiError(
                    "wiki_timeout", "访问 GitLab 超时", retryable=True
                )
                if attempt == attempts - 1:
                    raise last_error
                await asyncio.sleep(0.5 * (attempt + 1))
            except aiohttp.ClientError:
                last_error = WikiApiError(
                    "wiki_unreachable", "无法连接 GitLab", retryable=True
                )
                if attempt == attempts - 1:
                    raise last_error
                await asyncio.sleep(0.5 * (attempt + 1))
        raise last_error or WikiApiError("upstream_error", "GitLab API 请求失败")

    async def list_projects(
        self, *, search: str = "", limit: int = 100, offset: int = 0
    ) -> GitLabPage:
        page_size, page = self._pagination(limit, offset)
        payload, headers = await self._request(
            "GET",
            "/projects",
            params={
                "membership": "true",
                "simple": "true",
                "order_by": "last_activity_at",
                "sort": "desc",
                "search": search or None,
                "per_page": page_size,
                "page": page,
            },
        )
        if not isinstance(payload, list):
            raise WikiApiError("upstream_error", "GitLab 项目列表响应格式错误")
        return GitLabPage(payload, self._next_offset(headers, page_size))

    async def get_project(self, project_path: str) -> dict[str, Any]:
        payload, _ = await self._request(
            "GET",
            f"/projects/{self._project(project_path)}",
            not_found_code="external_scope_invalid",
        )
        if not isinstance(payload, dict):
            raise WikiApiError("upstream_error", "GitLab 项目响应格式错误")
        return payload

    async def list_branches(
        self, project_path: str, *, limit: int = 100, offset: int = 0
    ) -> GitLabPage:
        page_size, page = self._pagination(limit, offset)
        payload, headers = await self._request(
            "GET",
            f"/projects/{self._project(project_path)}/repository/branches",
            params={"per_page": page_size, "page": page},
            not_found_code="external_scope_invalid",
        )
        if not isinstance(payload, list):
            raise WikiApiError("upstream_error", "GitLab 分支列表响应格式错误")
        return GitLabPage(payload, self._next_offset(headers, page_size))

    async def get_branch(self, project_path: str, branch: str) -> dict[str, Any]:
        payload, _ = await self._request(
            "GET",
            f"/projects/{self._project(project_path)}/repository/branches/"
            f"{self._path(branch)}",
            not_found_code="external_scope_invalid",
        )
        if not isinstance(payload, dict):
            raise WikiApiError("upstream_error", "GitLab 分支响应格式错误")
        return payload

    async def list_repository_tree(
        self,
        project_path: str,
        *,
        ref: str,
        path: str = "",
        limit: int = 100,
        offset: int = 0,
    ) -> GitLabPage:
        page_size, page = self._pagination(limit, offset)
        payload, headers = await self._request(
            "GET",
            f"/projects/{self._project(project_path)}/repository/tree",
            params={
                "ref": ref,
                "path": path or None,
                "recursive": "false",
                "per_page": page_size,
                "page": page,
            },
            not_found_code="external_scope_invalid",
        )
        if not isinstance(payload, list):
            raise WikiApiError("upstream_error", "GitLab 文件树响应格式错误")
        return GitLabPage(payload, self._next_offset(headers, page_size))

    async def get_repository_file(
        self, project_path: str, *, path: str, ref: str
    ) -> dict[str, Any]:
        file_limit = settings.MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024
        encoded_limit = ((file_limit + 2) // 3) * 4
        folded_line_count = (
            encoded_limit + _LEGACY_BASE64_LINE_LENGTH - 1
        ) // _LEGACY_BASE64_LINE_LENGTH
        response_limit = encoded_limit + folded_line_count * 4 + 1024 * 1024
        payload, _ = await self._request(
            "GET",
            f"/projects/{self._project(project_path)}/repository/files/{self._path(path)}",
            params={"ref": ref},
            max_bytes=response_limit,
            response_too_large_code="external_file_too_large",
            response_too_large_message="GitLab 文件超过知识库上传大小限制",
            timeout=self._download_timeout(),
            max_attempts=1,
        )
        if not isinstance(payload, dict):
            raise WikiApiError("upstream_error", "GitLab 文件响应格式错误")
        return payload

    async def get_repository_file_metadata(
        self, project_path: str, *, path: str, ref: str
    ) -> dict[str, str]:
        _, headers = await self._request(
            "HEAD",
            f"/projects/{self._project(project_path)}/repository/files/{self._path(path)}",
            params={"ref": ref},
            headers_only=True,
        )
        return {str(key).lower(): str(value) for key, value in headers.items()}

    async def list_project_wikis(
        self, project_path: str, *, with_content: bool = False
    ) -> list[dict[str, Any]]:
        payload, _ = await self._request(
            "GET",
            f"/projects/{self._project(project_path)}/wikis",
            params={"with_content": str(with_content).lower()},
            not_found_code="external_scope_invalid",
            max_bytes=GITLAB_WIKI_LIST_MAX_RESPONSE_BYTES,
            response_too_large_message="GitLab Wiki 页面列表响应过大",
        )
        if not isinstance(payload, list):
            raise WikiApiError("upstream_error", "GitLab Wiki 列表响应格式错误")
        return payload

    async def get_project_wiki(self, project_path: str, *, slug: str) -> dict[str, Any]:
        content_limit = settings.MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024
        payload, _ = await self._request(
            "GET",
            f"/projects/{self._project(project_path)}/wikis/{self._path(slug)}",
            max_bytes=(content_limit * _MAX_JSON_STRING_EXPANSION + 1024 * 1024),
            response_too_large_code="external_file_too_large",
            response_too_large_message="GitLab Wiki 页面超过知识库上传大小限制",
            timeout=self._download_timeout(),
            max_attempts=1,
        )
        if not isinstance(payload, dict):
            raise WikiApiError("upstream_error", "GitLab Wiki 页面响应格式错误")
        return payload
