# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External Wiki connection, synchronized import, and page-picker endpoints.

The module is named external_wiki because endpoints/wiki.py is taken by the
code-wiki internal router.
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
    WikiConnectionsResponse,
    WikiConnectionSummary,
    WikiConnectionTestRequest,
    WikiConnectionTestResponse,
    WikiConnectorOption,
    WikiNamedConnectionUpdateRequest,
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
from app.services.wiki.service import (
    WikiConnectionService,
    list_kb_wiki_source_documents,
    unbind_kb_wiki_document,
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


def _connection_references(
    db: Session, *, owner_user_id: int, connection_id: str
) -> list[KnowledgeDocument]:
    documents = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.user_id == owner_user_id,
            KnowledgeDocument.source_type == DocumentSourceType.EXTERNAL.value,
        )
        .all()
    )
    return [
        document
        for document in documents
        if wiki_document_uses_connection(document, connection_id)
    ]


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
        normalized_site_url = await asyncio.to_thread(
            validate_wiki_site_url, body.site_url
        )
        item = WikiConnectionService.save_named_connection(
            db,
            current_user,
            connection_id=None,
            display_name=body.display_name,
            connector_type=body.connector_type,
            site_url=normalized_site_url,
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
        normalized_site_url = await asyncio.to_thread(
            validate_wiki_site_url, body.site_url
        )
        existing = external_source_connection_service.get_owned(
            db,
            owner_user_id=current_user.id,
            provider_id="wiki",
            connection_id=connection_id,
            include_inactive=True,
            for_update=True,
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="Wiki 连接不存在")
        target_changed = (
            existing.adapter_type != body.connector_type
            or str(existing.config.get("site_url") or "").rstrip("/")
            != normalized_site_url
        )
        if target_changed:
            references = _connection_references(
                db,
                owner_user_id=current_user.id,
                connection_id=connection_id,
            )
            if references:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "该连接仍被以下知识库引用，不能修改 Wiki 站点或连接器："
                        f"{_wiki_reference_summary(db, references)}。"
                        "请新建连接，或先删除相关 Wiki 文档"
                    ),
                )
        item = WikiConnectionService.save_named_connection(
            db,
            current_user,
            connection_id=connection_id,
            display_name=body.display_name,
            connector_type=body.connector_type,
            site_url=normalized_site_url,
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
    existing = external_source_connection_service.get_owned(
        db,
        owner_user_id=current_user.id,
        provider_id="wiki",
        connection_id=connection_id,
        include_inactive=True,
        for_update=True,
    )
    if existing is None:
        raise HTTPException(status_code=404, detail="Wiki 连接不存在")
    references = _connection_references(
        db,
        owner_user_id=current_user.id,
        connection_id=connection_id,
    )
    if references:
        reference_summary = _wiki_reference_summary(db, references)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"该连接仍被以下知识库引用：{reference_summary}。"
                "请先删除相关 Wiki 文档"
            ),
        )

    deleted = external_source_connection_service.disable_owned(
        db,
        owner_user_id=current_user.id,
        provider_id="wiki",
        connection_id=connection_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Wiki 连接不存在")


@router.post("/wiki/connection/test", response_model=WikiConnectionTestResponse)
async def test_wiki_connection(
    body: Optional[WikiConnectionTestRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Test unsaved values or a stored named connection."""
    register_builtin_connectors()
    stored_connection = None
    if body and body.connection_id:
        stored_connection = (
            WikiConnectionService.get_user_wiki_connection_for_connection_test(
                current_user, db=db, connection_id=body.connection_id
            )
        )
    saved = {
        "connector_type": (
            stored_connection.connector.connector_type if stored_connection else None
        ),
        "site_url": stored_connection.config.site_url if stored_connection else "",
        "default_locale": (
            stored_connection.config.default_locale if stored_connection else None
        ),
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
        api_key = stored_connection.config.api_key if stored_connection else ""
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
    db.commit()
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
    """Test one named Wiki connection, optionally with edited unsaved values."""
    request = (
        body or WikiConnectionTestRequest(connection_id=connection_id)
    ).model_copy(update={"connection_id": connection_id})
    return await test_wiki_connection(request, db, current_user)


# ---------------------------------------------------------------------------
# Synchronized Wiki documents
# ---------------------------------------------------------------------------


def _bound_document(document: KnowledgeDocument) -> WikiBoundDocument:
    sync = get_document_sync_config(document)
    external = document.external_source_config
    index_status = getattr(document.index_status, "value", document.index_status)
    return WikiBoundDocument(
        id=document.id,
        page_id=str(sync.get("resource_id") or ""),
        name=document.name,
        path=str(sync.get("path") or ""),
        locale=str(sync.get("locale") or ""),
        page_updated_at=str(sync.get("observed_version") or ""),
        resource_url=str(external.get("url") or ""),
        status=str(index_status),
        connection_id=str(sync.get("connection_id") or "") or None,
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
    """Import selected Wiki pages as synchronized knowledge documents."""
    kb = _load_kb(db, knowledge_base_id)
    _require_kb_edit(db, kb, current_user)
    try:
        if not settings.EXTERNAL_DOC_SYNC_ENABLED:
            raise WikiApiError("bad_request", "外部文档同步功能未启用")
        provider = get_external_sync_provider("wiki")
        if provider is None:
            raise WikiApiError("bad_request", "Wiki 同步服务不可用")
        resolved = await provider.resolve_selections(
            db,
            current_user,
            body.connection_id,
            body.page_ids,
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
    except ExternalDocumentImportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except WikiApiError as exc:
        raise _wiki_error(exc)
    return WikiBindingCreateResponse(
        documents=[_bound_document(document) for document in created],
        duplicate_documents=[
            _bound_document(document) for document in result.duplicates
        ],
        created_count=len(result.created),
        updated_count=len(result.updated),
        processing_count=len(result.processing),
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


# ---------------------------------------------------------------------------
# Import picker page discovery
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


# Page-list cache: one independent key per connection revision and locale.
# Best-effort: Redis failures fall through to a remote picker refresh.
_PAGES_CACHE_TTL_SECONDS = 300
_PAGE_LIST_TRUNCATED_WARNING = "wiki_page_list_truncated"


def _pages_cache_key(subject: str, locale: Optional[str]) -> str:
    return f"wiki:pages:{subject}:locale:{locale or '_default'}"


async def _cached_page_list(
    subject: str,
    locale: Optional[str],
    refresh: bool,
    fetch_all,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Serve the full ordered page list from cache, fetching on miss."""
    key = _pages_cache_key(subject, locale)
    if not refresh:
        cached = await cache_manager.get(key)
        if isinstance(cached, dict) and isinstance(cached.get("pages"), list):
            warnings = cached.get("warnings")
            return cached["pages"], warnings if isinstance(warnings, list) else []
    summaries, warnings = await fetch_all()
    ttl = _PAGES_CACHE_TTL_SECONDS if summaries else 60
    await cache_manager.set(
        key,
        {"pages": summaries, "warnings": warnings},
        expire=ttl,
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


@router.get("/wiki/pages", response_model=WikiPagesResponse)
async def list_wiki_pages(
    path: Optional[str] = Query(None),
    locale: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    refresh: bool = Query(False),
    connection_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List pages from one connection for the synchronized-import picker."""
    if not connection_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请选择 Wiki 连接",
        )
    connection = WikiConnectionService.get_user_wiki_connection(
        current_user, db=db, connection_id=connection_id
    )
    if connection is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请先在「设置 → 集成」配置外部 Wiki 连接",
        )
    cache_scope = (
        f"user:{current_user.id}:{connection.connection_id}:"
        f"revision:{connection.revision}"
    )
    db.commit()

    async def fetch_all() -> tuple[list[dict[str, Any]], list[str]]:
        pages, upstream_next_offset = await connection.connector.list_pages(
            connection.config,
            path=None,
            locale=locale,
            limit=settings.WIKI_TREE_MAX_PAGES,
        )
        warnings = (
            [_PAGE_LIST_TRUNCATED_WARNING] if upstream_next_offset is not None else []
        )
        return (
            [_summary(connection.config, meta).model_dump() for meta in pages],
            warnings,
        )

    try:
        summaries, warnings = await _cached_page_list(
            cache_scope,
            locale,
            refresh,
            fetch_all,
        )
    except WikiApiError as exc:
        raise _wiki_error(exc) from exc
    batch, next_offset = _filter_and_slice(summaries, path, limit, offset)
    return WikiPagesResponse(
        pages=[WikiPageSummary(**item) for item in batch],
        next_offset=next_offset,
        warnings=warnings,
    )
