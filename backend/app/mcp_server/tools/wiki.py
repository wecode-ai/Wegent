# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bridge MCP tools for external wiki access (connector-agnostic).

Identity model (design §5.4): the task token identifies the querier for
audit and rate limiting only; page fetching always runs with the binding
adder's delegated connection, and every path is server-side checked
against the authorized scope table before any outbound call.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from app.core.config import settings
from app.core.rate_limit import (
    ExternalMcpRateLimitStatus,
    check_external_mcp_dimension_rate_limit,
)
from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.wiki.connector import WikiApiError, build_page_url
from app.services.wiki.content import (
    extract_outline,
    slice_section,
    truncate_content,
)
from app.services.wiki.service import (
    collect_wiki_scope_entries,
    gather_scope_pages,
    pick_scope_for_path,
    search_scope_pages,
)
from app.stores.tasks import task_store

logger = logging.getLogger(__name__)

_PROVIDER_CONFIG_GUIDANCE = "wegent://modal/mcp-provider-config"
_RATE_WINDOW_SECONDS = 60


def _error(
    code: str,
    message: str,
    *,
    connector: Optional[str] = None,
    guidance: Optional[str] = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code, "message": message}
    if connector:
        payload["connector"] = connector
    if guidance:
        payload["guidance"] = guidance
    return {"error": payload}


def _rate_limited(*dimensions: str) -> bool:
    """Fixed-window limit per dimension; unavailable Redis means allowed."""
    limits = {
        "user": 60,
        "task": 100,
        "credential": 120,
    }
    for dimension in dimensions:
        kind, _, value = dimension.partition(":")
        limit = limits.get(kind, 0)
        if limit <= 0 or not value:
            continue
        result = check_external_mcp_dimension_rate_limit(
            dimensions=[dimension],
            namespace="wiki_bridge",
            limit=limit,
            window_seconds=_RATE_WINDOW_SECONDS,
        )
        if result == ExternalMcpRateLimitStatus.LIMITED:
            return True
    return False


class _ScopeContext:
    """Resolved scopes for one tool invocation."""

    def __init__(self, entries, unavailable, token_info):
        self.entries = entries
        self.unavailable = unavailable
        self.token_info = token_info

    @property
    def user_key(self) -> str:
        return f"user:{self.token_info.user_id}"

    @property
    def task_key(self) -> str:
        return f"task:{self.token_info.task_id}"


def _load_scopes(token_info: TaskTokenInfo) -> _ScopeContext:
    db = SessionLocal()
    try:
        task = task_store.get_by_id(db, task_id=token_info.task_id)
        if task is None:
            raise WikiApiError("upstream_error", f"任务不存在：{token_info.task_id}")
        entries, unavailable = collect_wiki_scope_entries(
            db, task, token_info.subtask_id
        )
        return _ScopeContext(entries, unavailable, token_info)
    finally:
        db.close()


def _no_entries_error(context: _ScopeContext) -> dict[str, Any]:
    if context.unavailable:
        return _error(
            "wiki_credential_unavailable",
            "；".join(context.unavailable),
        )
    return _error(
        "wiki_not_configured",
        "当前任务没有选择带外部 Wiki 绑定的知识库",
        guidance=_PROVIDER_CONFIG_GUIDANCE,
    )


async def _budget_error(
    context: _ScopeContext, *extra: str
) -> Optional[dict[str, Any]]:
    dimensions = [context.user_key, context.task_key, *extra]
    limited = await asyncio.to_thread(_rate_limited, *dimensions)
    return (
        _error(
            "wiki_rate_limited",
            "外部 Wiki 访问过于频繁，请稍后再试",
        )
        if limited
        else None
    )


def _meta_payload(config_site_url: str, meta: Any) -> dict[str, Any]:
    return {
        "id": meta.id,
        "path": meta.path,
        "title": meta.title,
        "description": meta.description,
        "updated_at": meta.updated_at,
        "tags": list(meta.tags),
        "locale": meta.locale,
        "is_published": meta.is_published,
        "page_url": build_page_url(config_site_url, meta.path),
    }


@mcp_tool(
    name="wiki_list_pages",
    description=(
        "List published pages of the selected external wiki, optionally "
        "under a path prefix. Only paths inside the selected sources are "
        "authorized. Returns metadata plus page_url; fetch bodies with "
        "wiki_get_page."
    ),
    server="wiki",
    exclude_params=["token_info"],
)
async def wiki_list_pages(
    token_info: TaskTokenInfo,
    path: Optional[str] = None,
    locale: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    try:
        context = _load_scopes(token_info)
    except WikiApiError as exc:
        return _error(exc.error_code, exc.message)
    if not context.entries:
        return _no_entries_error(context)
    if path:
        entry = pick_scope_for_path(context.entries, path)
        if entry is None:
            return _error(
                "wiki_out_of_scope",
                f"path 不在已选 Wiki 范围内：{path}",
            )
        budget_error = await _budget_error(context, f"credential:{entry.owner_user_id}")
        if budget_error:
            return budget_error
        try:
            metas, next_offset = await entry.connector.list_pages(
                entry.config,
                path=path,
                locale=locale,
                limit=limit,
                offset=offset,
            )
        except WikiApiError as exc:
            return _error(
                exc.error_code, exc.message, connector=entry.connector.connector_type
            )
        return {
            "site_url": entry.config.site_url,
            "pages": [_meta_payload(entry.config.site_url, meta) for meta in metas],
            "next_offset": next_offset,
        }
    budget_error = await _budget_error(context)
    if budget_error:
        return budget_error
    credential_keys = {f"credential:{entry.owner_user_id}" for entry in context.entries}
    budget_error = await _budget_error(context, *sorted(credential_keys))
    if budget_error:
        return budget_error
    try:
        batch, next_offset, warnings = await gather_scope_pages(
            context.entries,
            path=None,
            locale=locale,
            limit=limit,
            offset=offset,
            max_pages=settings.WIKI_TREE_MAX_PAGES,
        )
    except WikiApiError as exc:
        return _error(exc.error_code, exc.message)
    return {
        "site_url": batch[0][0].config.site_url if batch else "",
        "pages": [_meta_payload(entry.config.site_url, meta) for entry, meta in batch],
        "next_offset": next_offset,
        "warnings": warnings + context.unavailable,
    }


@mcp_tool(
    name="wiki_get_page",
    description=(
        "Read one external wiki page as Markdown. `path` must be inside the "
        "selected sources. Long pages return an outline and a truncated "
        "body; pass the desired heading as `section` to read that part."
    ),
    server="wiki",
    exclude_params=["token_info"],
)
async def wiki_get_page(
    token_info: TaskTokenInfo,
    path: str,
    locale: Optional[str] = None,
    section: Optional[str] = None,
) -> dict[str, Any]:
    try:
        context = _load_scopes(token_info)
    except WikiApiError as exc:
        return _error(exc.error_code, exc.message)
    if not context.entries:
        return _no_entries_error(context)
    entry = pick_scope_for_path(context.entries, path)
    if entry is None:
        return _error("wiki_out_of_scope", f"path 不在已选 Wiki 范围内：{path}")
    budget_error = await _budget_error(context, f"credential:{entry.owner_user_id}")
    if budget_error:
        return budget_error
    try:
        page = await entry.connector.get_page(entry.config, path, locale)
    except WikiApiError as exc:
        return _error(
            exc.error_code, exc.message, connector=entry.connector.connector_type
        )
    if page is None:
        return _error(
            "wiki_page_not_found",
            f"Wiki 页面不存在：{path}",
            connector=entry.connector.connector_type,
        )
    full_content = page.content
    if section:
        sliced = slice_section(full_content, section)
        if sliced is None:
            return _error(
                "bad_request",
                f"页面中不存在标题小节「{section}」；请从 outline 中选择标题",
                connector=entry.connector.connector_type,
            )
        full_content = sliced
    body, truncated, total_chars = truncate_content(
        full_content, settings.WIKI_PAGE_CONTENT_MAX_CHARS
    )
    return {
        "id": page.id,
        "path": page.path,
        "title": page.title,
        "locale": page.locale,
        "updated_at": page.updated_at,
        "tags": list(page.tags),
        "is_published": page.is_published,
        "page_url": build_page_url(entry.config.site_url, page.path),
        "outline": [
            {"level": item.level, "title": item.title}
            for item in extract_outline(page.content)
        ],
        "content": body,
        "content_total_chars": total_chars,
        "truncated": truncated,
    }


@mcp_tool(
    name="wiki_search",
    description=(
        "Keyword-search the selected external wiki (metadata only: path, "
        "title, description). Fetch the body with wiki_get_page before "
        "quoting or summarizing."
    ),
    server="wiki",
    exclude_params=["token_info"],
)
async def wiki_search(
    token_info: TaskTokenInfo,
    query: str,
    path: Optional[str] = None,
    locale: Optional[str] = None,
    limit: int = 10,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 20))
    try:
        context = _load_scopes(token_info)
    except WikiApiError as exc:
        return _error(exc.error_code, exc.message)
    if not context.entries:
        return _no_entries_error(context)
    if path and pick_scope_for_path(context.entries, path) is None:
        return _error("wiki_out_of_scope", f"path 不在已选 Wiki 范围内：{path}")
    credential_keys = {f"credential:{entry.owner_user_id}" for entry in context.entries}
    budget_error = await _budget_error(context, *sorted(credential_keys))
    if budget_error:
        return budget_error
    try:
        results, warnings = await search_scope_pages(
            context.entries,
            query,
            path=path,
            locale=locale,
            limit=limit,
            max_pages=settings.WIKI_TREE_MAX_PAGES,
        )
    except WikiApiError as exc:
        return _error(exc.error_code, exc.message)
    return {
        "results": [
            _meta_payload(entry.config.site_url, meta) for entry, meta in results
        ],
        "warnings": warnings + context.unavailable,
    }
