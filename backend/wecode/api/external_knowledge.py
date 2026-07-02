# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read-only external knowledge browse endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.schemas.external_knowledge import (
    ExternalKbNodesResponse,
    ExternalKnowledgeBaseListResponse,
    ExternalKnowledgeHealthResponse,
    ExternalPreviewResponse,
    ExternalSearchRequest,
    ExternalSearchResult,
)
from wecode.service.external_knowledge.exceptions import ExternalKnowledgeError
from wecode.service.external_knowledge.service import external_knowledge_service

router = APIRouter()


def _raise_external_error(exc: ExternalKnowledgeError) -> None:
    raise HTTPException(
        status_code=exc.status_code,
        detail={
            "code": exc.code,
            "message": exc.message,
        },
    ) from exc


@router.get("/{provider}/health", response_model=ExternalKnowledgeHealthResponse)
async def external_knowledge_health(
    provider: str,
    _current_user: User = Depends(security.get_current_user),
):
    """Check external knowledge provider health."""
    try:
        return await external_knowledge_service.health(provider)
    except ExternalKnowledgeError as exc:
        _raise_external_error(exc)


@router.get(
    "/{provider}/knowledge-bases",
    response_model=ExternalKnowledgeBaseListResponse,
)
async def list_external_knowledge_bases(
    provider: str,
    scope: str = Query(default="all", pattern="^(all|personal|organization)$"),
    query: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List external knowledge bases visible to the current employee."""
    try:
        return await external_knowledge_service.list_knowledge_bases(
            db,
            current_user,
            provider,
            scope=scope,
            query=query,
            limit=limit,
            offset=offset,
        )
    except ExternalKnowledgeError as exc:
        _raise_external_error(exc)


@router.get(
    "/{provider}/knowledge-bases/{kb_id}/nodes",
    response_model=ExternalKbNodesResponse,
    response_model_exclude_none=True,
)
async def list_external_knowledge_nodes(
    provider: str,
    kb_id: str,
    folder_id: str | None = Query(default=None),
    recursive: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List nodes in an external knowledge base."""
    try:
        return await external_knowledge_service.list_nodes(
            db,
            current_user,
            provider,
            kb_id=kb_id,
            folder_id=folder_id,
            recursive=recursive,
            limit=limit,
            offset=offset,
        )
    except ExternalKnowledgeError as exc:
        _raise_external_error(exc)


@router.post("/{provider}/search", response_model=ExternalSearchResult)
async def search_external_knowledge(
    provider: str,
    request: ExternalSearchRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Search selected external knowledge bases."""
    try:
        return await external_knowledge_service.search(
            db,
            current_user,
            provider,
            query=request.query,
            knowledge_base_ids=request.knowledge_base_ids,
            max_results=request.max_results,
        )
    except ExternalKnowledgeError as exc:
        _raise_external_error(exc)


@router.get("/{provider}/preview", response_model=ExternalPreviewResponse)
async def preview_external_knowledge(
    provider: str,
    kb_id: str = Query(..., min_length=1),
    node_id: str | None = Query(default=None),
    document_id: str | None = Query(default=None),
    folder_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Resolve an authorized preview URL for a single external document."""
    try:
        return await external_knowledge_service.preview(
            db,
            current_user,
            provider,
            kb_id=kb_id,
            node_id=node_id,
            document_id=document_id,
            folder_id=folder_id,
        )
    except ExternalKnowledgeError as exc:
        _raise_external_error(exc)
