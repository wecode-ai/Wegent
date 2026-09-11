# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External wiki REST endpoints: connection settings, KB bindings, browse.

The module is named external_wiki because endpoints/wiki.py is taken by the
code-wiki internal router. Routes keep the design-doc paths:
/api/wiki/connection, /api/wiki/pages, /api/wiki/page and
/api/knowledge/{id}/wiki-bindings.
"""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.cache import cache_manager
from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentSourceType, KnowledgeDocument
from app.schemas.external_wiki import (
    WikiBindingCreateRequest,
    WikiBindingCreateResponse,
    WikiBoundDocument,
    WikiConnectionResponse,
    WikiConnectionsResponse,
    WikiConnectionSummary,
    WikiConnectionTestRequest,
    WikiConnectionTestResponse,
    WikiConnectionUpdateRequest,
    WikiConnectorOption,
    WikiNamedConnectionUpdateRequest,
    WikiOutlineItem,
    WikiPageDetail,
    WikiPagesResponse,
    WikiPageSummary,
)
from app.services.external_source_connections import external_source_connection_service
from app.services.knowledge.external_document_import import (
    ExternalDocumentImportError,
    external_document_import_service,
)
from app.services.knowledge.external_sync_providers import (
    get_document_sync_config,
    get_external_sync_provider,
)
from app.services.knowledge.knowledge_access_policy import (
    can_directly_access_knowledge_base,
    resolve_knowledge_base_permission,
)
from app.services.knowledge.permission_policy import (
    can_manage_accessible_knowledge_base_documents,
)
from app.services.wiki.connector import (
    WIKI_CONNECTORS,
    WikiApiError,
    WikiSiteConfig,
    build_page_url,
    register_builtin_connectors,
)
from app.services.wiki.connectors.wikijs import validate_wiki_site_url
from app.services.wiki.content import extract_outline, truncate_content
from app.services.wiki.service import (
    LEGACY_WIKI_CONNECTION_ID,
    WikiConnectionService,
    _resolve_entries,
    bind_kb_wiki_documents,
    gather_scope_pages,
    list_kb_wiki_documents,
    list_kb_wiki_source_documents,
    pick_scope_for_path,
    unbind_kb_wiki_document,
    wiki_document_source_identity,
    wiki_document_uses_connection,
)
from shared.models.db import User

logger = logging.getLogger(__name__)

router = APIRouter()


def _wiki_error(exc: WikiApiError) -> HTTPException:
    client_codes = {"bad_request", "wiki_not_configured"}
    code = status.HTTP_400_BAD_REQUEST
    if exc.error_code not in client_codes:
        code = status.HTTP_502_BAD_GATEWAY
    return HTTPException(status_code=code, detail=exc.message)


def _load_kb(db: Session, knowledge_base_id: int) -> Kind:
    kb = (
        db.query(Kind)
        .filter(
            Kind.id == knowledge_base_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if kb is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="知识库不存在"
        )
    return kb


def _require_kb_read(db: Session, kb: Kind, user: User) -> None:
    if not can_directly_access_knowledge_base(db, kb.id, user.id, kb=kb):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="无权访问该知识库"
        )


def _require_kb_edit(db: Session, kb: Kind, user: User) -> None:
    permission = resolve_knowledge_base_permission(db, kb, user.id)
    if not can_manage_accessible_knowledge_base_documents(
        has_access=permission.has_access,
        role=permission.role,
        is_creator=permission.is_creator,
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要知识库编辑权限才能管理外部 Wiki 绑定",
        )


# ---------------------------------------------------------------------------
# Connection settings
# ---------------------------------------------------------------------------


def _available_connectors() -> list[WikiConnectorOption]:
    register_builtin_connectors()
    return [
        WikiConnectorOption(type=c.connector_type, display_name=c.display_name)
        for c in WIKI_CONNECTORS.list()
    ]


@router.get("/wiki/connection", response_model=WikiConnectionResponse)
async def get_wiki_connection(
    current_user: User = Depends(security.get_current_user),
):
    """Return the current user's wiki connection summary (key always masked)."""
    return WikiConnectionResponse(
        **WikiConnectionService.describe(current_user),
        available_connectors=_available_connectors(),
    )


def _connection_summary(item: dict[str, Any]) -> WikiConnectionSummary:
    return WikiConnectionSummary(**item, available_connectors=_available_connectors())


def _knowledge_base_display_name(knowledge_base: Kind) -> str:
    spec = (knowledge_base.json or {}).get("spec") or {}
    return str(
        spec.get("name") or knowledge_base.name or f"知识库 #{knowledge_base.id}"
    )


def _wiki_reference_summary(db: Session, references: list[KnowledgeDocument]) -> str:
    reference_counts = Counter(document.kind_id for document in references)
    knowledge_base_ids = [kind_id for kind_id in reference_counts if kind_id]
    knowledge_bases = (
        db.query(Kind)
        .filter(
            Kind.id.in_(knowledge_base_ids),
            Kind.kind == "KnowledgeBase",
        )
        .all()
        if knowledge_base_ids
        else []
    )
    names_by_id = {
        knowledge_base.id: _knowledge_base_display_name(knowledge_base)
        for knowledge_base in knowledge_bases
    }

    summaries = []
    for kind_id, count in reference_counts.items():
        name = names_by_id.get(kind_id, f"知识库 #{kind_id}")
        summaries.append(f"{name}（{count} 篇文档）")
    return "、".join(summaries)


@router.get("/wiki/connections", response_model=WikiConnectionsResponse)
async def list_wiki_connections(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    options = _available_connectors()
    return WikiConnectionsResponse(
        connections=[
            WikiConnectionSummary(**item, available_connectors=options)
            for item in WikiConnectionService.list_connections(db, current_user)
        ],
        available_connectors=options,
    )


@router.post("/wiki/connections", response_model=WikiConnectionSummary)
async def create_named_wiki_connection(
    body: WikiNamedConnectionUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    try:
        await asyncio.to_thread(validate_wiki_site_url, body.site_url)
        item = WikiConnectionService.save_named_connection(
            db,
            current_user,
            connection_id=None,
            display_name=body.display_name,
            connector_type=body.connector_type,
            site_url=body.site_url,
            api_key=body.api_key,
            default_locale=body.default_locale,
            enabled=body.enabled,
        )
    except WikiApiError as exc:
        raise _wiki_error(exc)
    return _connection_summary(item)


@router.put("/wiki/connections/{connection_id}", response_model=WikiConnectionSummary)
async def update_named_wiki_connection(
    connection_id: str,
    body: WikiNamedConnectionUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    try:
        await asyncio.to_thread(validate_wiki_site_url, body.site_url)
        item = WikiConnectionService.save_named_connection(
            db,
            current_user,
            connection_id=connection_id,
            display_name=body.display_name,
            connector_type=body.connector_type,
            site_url=body.site_url,
            api_key=body.api_key,
            default_locale=body.default_locale,
            enabled=body.enabled,
        )
    except WikiApiError as exc:
        raise _wiki_error(exc)
    return _connection_summary(item)


@router.delete(
    "/wiki/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_wiki_connection(
    connection_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    documents = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.user_id == current_user.id,
            KnowledgeDocument.source_type.in_(
                [
                    DocumentSourceType.EXTERNAL_WIKI.value,
                    DocumentSourceType.EXTERNAL.value,
                ]
            ),
        )
        .all()
    )
    references = [
        document
        for document in documents
        if wiki_document_uses_connection(document, connection_id)
    ]
    if references:
        reference_summary = _wiki_reference_summary(db, references)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"该连接仍被以下知识库引用：{reference_summary}。"
                "请先删除相关 Wiki 文档"
            ),
        )

    if connection_id == LEGACY_WIKI_CONNECTION_ID:
        current_user.preferences = WikiConnectionService.delete_legacy_connection(
            current_user
        )
        db.add(current_user)
        db.commit()
        return

    deleted = external_source_connection_service.disable_owned(
        db,
        owner_user_id=current_user.id,
        provider_id="wiki",
        connection_id=connection_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Wiki 连接不存在")


@router.put("/wiki/connection", response_model=WikiConnectionResponse)
async def update_wiki_connection(
    body: WikiConnectionUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Save the wiki connection; switching connector type resets credentials."""
    try:
        await asyncio.to_thread(validate_wiki_site_url, body.site_url)
    except WikiApiError as exc:
        raise _wiki_error(exc)
    try:
        preferences = WikiConnectionService.save_connection(
            current_user,
            connector_type=body.connector_type,
            site_url=body.site_url,
            api_key=body.api_key,
            default_locale=body.default_locale,
            enabled=body.enabled,
        )
    except WikiApiError as exc:
        raise _wiki_error(exc)
    current_user.preferences = preferences
    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    return WikiConnectionResponse(
        **WikiConnectionService.describe(current_user),
        available_connectors=_available_connectors(),
    )


@router.post("/wiki/connection/test", response_model=WikiConnectionTestResponse)
async def test_wiki_connection(
    body: Optional[WikiConnectionTestRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Test unsaved values when provided, otherwise the saved connection."""
    register_builtin_connectors()
    saved = WikiConnectionService.describe(current_user)
    stored_connection = None
    if body and body.connection_id:
        stored_connection = WikiConnectionService.get_user_wiki_connection(
            current_user, db=db, connection_id=body.connection_id
        )
        if stored_connection:
            saved = {
                "connector_type": stored_connection.connector.connector_type,
                "site_url": stored_connection.config.site_url,
                "default_locale": stored_connection.config.default_locale,
            }
    connector_type = (
        body.connector_type
        if body and body.connector_type
        else (saved["connector_type"] or "wikijs")
    )
    site_url = body.site_url.strip() if body and body.site_url else saved["site_url"]
    connector = WIKI_CONNECTORS.get(connector_type)
    if connector is None:
        return WikiConnectionTestResponse(
            ok=False, message=f"不支持的连接器类型：{connector_type}"
        )
    api_key = (body.api_key or "").strip() if body else ""
    if not api_key:
        connection = (
            stored_connection
            or WikiConnectionService.get_connection_from_preferences(
                current_user.preferences
            )
        )
        api_key = connection.config.api_key if connection else ""
    if not site_url or not api_key:
        return WikiConnectionTestResponse(
            ok=False, message="请先填写站点地址与 API Key"
        )
    try:
        await asyncio.to_thread(validate_wiki_site_url, site_url)
    except WikiApiError as exc:
        return WikiConnectionTestResponse(ok=False, message=exc.message)
    config = WikiSiteConfig(
        site_url=site_url.rstrip("/"),
        api_key=api_key,
        default_locale=(body.default_locale if body else None)
        or saved["default_locale"],
    )
    result = await connector.test_connection(config)
    return WikiConnectionTestResponse(
        ok=result.ok, message=result.message, version=result.version
    )


@router.post(
    "/wiki/connections/{connection_id}/test",
    response_model=WikiConnectionTestResponse,
)
async def test_named_wiki_connection(
    connection_id: str,
    body: Optional[WikiConnectionTestRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Named-route alias; the legacy test endpoint remains backward compatible."""
    request = (body or WikiConnectionTestRequest()).model_copy(
        update={"connection_id": connection_id}
    )
    return await test_wiki_connection(request, db, current_user)


# ---------------------------------------------------------------------------
# KB wiki documents (live-bound pages)
# ---------------------------------------------------------------------------


def _bound_document(document: KnowledgeDocument) -> WikiBoundDocument:
    sync = get_document_sync_config(document)
    if sync.get("enabled"):
        external = document.external_source_config
        index_status = getattr(document.index_status, "value", document.index_status)
        return WikiBoundDocument(
            id=document.id,
            name=document.name,
            path=str(sync.get("path") or ""),
            locale=str(sync.get("locale") or ""),
            page_updated_at=str(sync.get("observed_version") or ""),
            resource_url=str(external.get("url") or ""),
            bound_at=external.get("last_success_at"),
            status=str(index_status),
            connection_id=str(sync.get("connection_id") or "") or None,
            sync=True,
        )
    config = document.source_config.get("wiki") or {}
    return WikiBoundDocument(
        id=document.id,
        name=document.name,
        path=str(config.get("path") or ""),
        locale=str(config.get("locale") or ""),
        page_updated_at=str(config.get("page_updated_at") or ""),
        resource_url=str(config.get("resource_url") or ""),
        bound_by=config.get("bound_by"),
        bound_at=config.get("bound_at"),
        connection_id=config.get("connection_id"),
        sync=False,
    )


@router.get(
    "/knowledge/{knowledge_base_id}/wiki-bindings",
    response_model=list[WikiBoundDocument],
)
async def list_kb_bindings(
    knowledge_base_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    kb = _load_kb(db, knowledge_base_id)
    _require_kb_read(db, kb, current_user)
    return [
        _bound_document(document)
        for document in list_kb_wiki_source_documents(db, knowledge_base_id)
    ]


@router.post(
    "/knowledge/{knowledge_base_id}/wiki-bindings",
    response_model=WikiBindingCreateResponse,
)
async def create_kb_binding(
    knowledge_base_id: int,
    body: WikiBindingCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Bind wiki pages (multi-select); bound_by is always the acting user."""
    kb = _load_kb(db, knowledge_base_id)
    _require_kb_edit(db, kb, current_user)
    try:
        if body.sync:
            if not settings.EXTERNAL_DOC_SYNC_ENABLED:
                raise WikiApiError("bad_request", "外部文档同步功能未启用")
            provider = get_external_sync_provider("wiki")
            if provider is None:
                raise WikiApiError("bad_request", "Wiki 同步服务不可用")
            resolved = await provider.resolve_selections(
                db,
                current_user,
                body.connection_id or "legacy-default",
                body.paths,
            )
            existing_identities = {
                identity
                for document in list_kb_wiki_source_documents(db, knowledge_base_id)
                if (identity := wiki_document_source_identity(document)) is not None
            }
            conflicts = [
                item.title
                for item in resolved
                if (item.locator.connection_id, str(item.metadata.get("path") or ""))
                in existing_identities
            ]
            if conflicts:
                raise ExternalDocumentImportError(
                    f"Wiki 页面已通过其他模式添加：{', '.join(conflicts)}",
                    status_code=status.HTTP_409_CONFLICT,
                )
            result = external_document_import_service.import_resolved_documents(
                db=db,
                user=current_user,
                knowledge_base_id=knowledge_base_id,
                provider_id="wiki",
                resolved_documents=resolved,
                folder_id=body.folder_id,
            )
            created = [*result.created, *result.updated, *result.processing]
            notes = []
        else:
            created, notes = await bind_kb_wiki_documents(
                db,
                kb,
                current_user,
                paths=body.paths,
                connection_id=body.connection_id,
            )
    except ExternalDocumentImportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except WikiApiError as exc:
        raise _wiki_error(exc)
    await _invalidate_kb_pages_cache(knowledge_base_id)
    return WikiBindingCreateResponse(
        documents=[_bound_document(document) for document in created],
        notes=notes,
    )


@router.delete(
    "/knowledge/{knowledge_base_id}/wiki-bindings/{document_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_kb_binding(
    knowledge_base_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    kb = _load_kb(db, knowledge_base_id)
    _require_kb_edit(db, kb, current_user)
    try:
        unbind_kb_wiki_document(
            db, knowledge_base_id, document_id, user_id=current_user.id
        )
    except WikiApiError as exc:
        raise _wiki_error(exc)
    await _invalidate_kb_pages_cache(knowledge_base_id)


# ---------------------------------------------------------------------------
# Tree browse and page preview
# ---------------------------------------------------------------------------


def _summary(config: WikiSiteConfig, meta: Any) -> WikiPageSummary:
    return WikiPageSummary(
        id=meta.id,
        path=meta.path,
        title=meta.title,
        description=meta.description,
        updated_at=meta.updated_at,
        tags=list(meta.tags),
        locale=meta.locale,
        is_published=meta.is_published,
        page_url=build_page_url(config.site_url, meta.path),
    )


# Page-list cache (design §5.6 P1): one key per browse subject, value is a
# {locale: [page dicts]} bucket so binding changes invalidate every locale at
# once. Best-effort: cache_manager swallows Redis failures and callers fall
# through to a live fetch.
_PAGES_CACHE_TTL_SECONDS = 300


def _pages_cache_key(subject: str) -> str:
    return f"wiki:pages:{subject}"


async def _cached_page_list(
    subject: str,
    locale: Optional[str],
    refresh: bool,
    fetch_all,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Serve the full ordered page list from cache, fetching on miss."""
    key = _pages_cache_key(subject)
    buckets: dict[str, Any] = {}
    if not refresh:
        cached = await cache_manager.get(key)
        if isinstance(cached, dict):
            buckets = cached
    locale_key = locale or ""
    cached_list = buckets.get(locale_key)
    if isinstance(cached_list, list) and cached_list:
        return cached_list, []
    summaries, warnings = await fetch_all()
    if summaries:
        await cache_manager.set(
            key, {**buckets, locale_key: summaries}, expire=_PAGES_CACHE_TTL_SECONDS
        )
    return summaries, warnings


def _filter_and_slice(
    summaries: list[dict[str, Any]],
    path: Optional[str],
    limit: int,
    offset: int,
) -> tuple[list[dict[str, Any]], Optional[int]]:
    prefix = (path or "").strip("/")
    if prefix:
        summaries = [
            item
            for item in summaries
            if item["path"] == prefix or item["path"].startswith(f"{prefix}/")
        ]
    batch = summaries[offset : offset + limit]
    next_offset = offset + limit if len(summaries) > offset + limit else None
    return batch, next_offset


async def _invalidate_kb_pages_cache(knowledge_base_id: int) -> None:
    await cache_manager.delete(_pages_cache_key(f"kb:{knowledge_base_id}"))


async def _list_pages_for_kb(
    db: Session,
    kb: Kind,
    path: Optional[str],
    locale: Optional[str],
    limit: int,
    offset: int,
    refresh: bool = False,
) -> WikiPagesResponse:
    """List pages visible through this KB's wiki documents (delegated)."""
    wiki_documents = list_kb_wiki_documents(db, kb.id)
    if not wiki_documents:
        return WikiPagesResponse(warnings=["该知识库还没有外部 Wiki 文档"])
    entries, unavailable = _resolve_entries(
        db, [(kb.id, document) for document in wiki_documents], []
    )
    if not entries:
        return WikiPagesResponse(warnings=unavailable or ["没有可用的绑定"])

    async def fetch_all() -> tuple[list[dict[str, Any]], list[str]]:
        batch_all, _, warnings = await gather_scope_pages(
            entries,
            path=None,
            locale=locale,
            limit=settings.WIKI_TREE_MAX_PAGES,
            offset=0,
            max_pages=settings.WIKI_TREE_MAX_PAGES,
        )
        return (
            [_summary(entry.config, meta).model_dump() for entry, meta in batch_all],
            warnings + list(unavailable),
        )

    summaries, warnings = await _cached_page_list(
        f"kb:{kb.id}", locale, refresh, fetch_all
    )
    batch, next_offset = _filter_and_slice(summaries, path, limit, offset)
    return WikiPagesResponse(
        pages=[WikiPageSummary(**item) for item in batch],
        next_offset=next_offset,
        warnings=warnings,
    )


@router.get("/wiki/pages", response_model=WikiPagesResponse)
async def list_wiki_pages(
    kb_id: Optional[int] = Query(None),
    path: Optional[str] = Query(None),
    locale: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    refresh: bool = Query(False),
    connection_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Two browse modes: kb_id (KB read + delegated bindings) or personal."""
    if kb_id is not None:
        kb = _load_kb(db, kb_id)
        _require_kb_read(db, kb, current_user)
        return await _list_pages_for_kb(
            db, kb, path, locale, limit, offset, refresh=refresh
        )
    connection = WikiConnectionService.get_user_wiki_connection(
        current_user, db=db, connection_id=connection_id
    )
    if connection is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请先在「设置 → 集成」配置外部 Wiki 连接",
        )

    async def fetch_all() -> tuple[list[dict[str, Any]], list[str]]:
        pages, _ = await connection.connector.list_pages(
            connection.config,
            path=None,
            locale=locale,
            limit=settings.WIKI_TREE_MAX_PAGES,
        )
        return (
            [_summary(connection.config, meta).model_dump() for meta in pages],
            [],
        )

    summaries, warnings = await _cached_page_list(
        f"user:{current_user.id}:{connection.connection_id}",
        locale,
        refresh,
        fetch_all,
    )
    batch, next_offset = _filter_and_slice(summaries, path, limit, offset)
    return WikiPagesResponse(
        pages=[WikiPageSummary(**item) for item in batch],
        next_offset=next_offset,
        warnings=warnings,
    )


@router.get("/wiki/page", response_model=WikiPageDetail)
async def get_wiki_page_preview(
    kb_id: int = Query(...),
    path: str = Query(...),
    locale: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Human preview of one bound wiki page (KB read + scope enforced)."""
    kb = _load_kb(db, kb_id)
    _require_kb_read(db, kb, current_user)
    wiki_documents = list_kb_wiki_documents(db, kb_id)
    entries, _ = _resolve_entries(
        db, [(kb.id, document) for document in wiki_documents], []
    )
    entry = pick_scope_for_path(entries, path)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该页面不在本知识库绑定的外部 Wiki 范围内",
        )
    page = await entry.connector.get_page(entry.config, path, locale)
    if page is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Wiki 页面不存在"
        )
    content, truncated, total = truncate_content(
        page.content, settings.WIKI_PAGE_CONTENT_MAX_CHARS
    )
    return WikiPageDetail(
        id=page.id,
        path=page.path,
        title=page.title,
        locale=page.locale,
        updated_at=page.updated_at,
        tags=list(page.tags),
        is_published=page.is_published,
        page_url=build_page_url(entry.config.site_url, page.path),
        content=content,
        content_total_chars=total,
        truncated=truncated,
        outline=[
            WikiOutlineItem(level=item.level, title=item.title)
            for item in extract_outline(content)
        ],
    )
