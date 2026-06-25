# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal knowledge capability endpoints for service-to-service calls."""

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.schemas.external_knowledge import ExternalKnowledgeRef
from app.services.auth.internal_service_token import verify_internal_service_token
from app.services.rag.sources import (
    RetrievalContext,
    retrieval_source_registry,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/knowledge",
    tags=["internal-knowledge"],
    dependencies=[Depends(verify_internal_service_token)],
)


class KnowledgeListDocumentsRequest(BaseModel):
    """Request for listing documents from mounted knowledge sources."""

    user_id: Optional[int] = Field(default=None, description="Current user ID")
    user_name: Optional[str] = Field(default=None, description="Current user name")
    external_knowledge_refs: list[ExternalKnowledgeRef] = Field(
        ..., min_length=1, description="External knowledge refs to list"
    )
    limit: int = Field(default=50, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class KnowledgeDocumentItem(BaseModel):
    """Normalized knowledge document list item."""

    provider: str
    source_id: str
    source_name: Optional[str] = None
    document_id: str
    title: str
    node_id: Optional[str] = None
    parent_id: Optional[str] = None
    mime_type: Optional[str] = None
    file_extension: Optional[str] = None
    source_uri: Optional[str] = None


class KnowledgeListDocumentsResponse(BaseModel):
    """Response for knowledge document listing."""

    documents: list[KnowledgeDocumentItem]
    total_returned: int
    pagination_scope: Literal["per_provider"] = "per_provider"
    warnings: list[str] = Field(default_factory=list)


@router.post("/list-documents", response_model=KnowledgeListDocumentsResponse)
async def list_documents(
    request: KnowledgeListDocumentsRequest,
):
    """List documents from providers that disclose document listing support."""
    if not request.user_id:
        raise HTTPException(
            status_code=400,
            detail="user_id is required for external knowledge document listing",
        )

    refs_by_provider: dict[str, list[ExternalKnowledgeRef]] = {}
    for ref in request.external_knowledge_refs:
        refs_by_provider.setdefault(ref.provider, []).append(ref)

    ctx = RetrievalContext(user_id=request.user_id, user_name=request.user_name)
    documents: list[KnowledgeDocumentItem] = []
    warnings: list[str] = []

    for provider_name, provider_refs in refs_by_provider.items():
        provider = retrieval_source_registry.get(provider_name)
        if provider is None:
            warnings.append(f"Knowledge provider is not registered: {provider_name}")
            continue

        list_provider_documents = getattr(provider, "list_documents", None)
        if not callable(list_provider_documents):
            warnings.append(
                f"Knowledge provider does not support document listing: {provider_name}"
            )
            continue

        try:
            result = await list_provider_documents(
                provider_refs,
                ctx,
                limit=request.limit,
                offset=request.offset,
            )
        except Exception:
            logger.warning(
                "[internal_knowledge] Document listing provider failed: %s",
                provider_name,
                exc_info=True,
            )
            warnings.append(f"Knowledge provider listing failed: {provider_name}")
            continue

        warnings.extend(result.warnings)
        documents.extend(
            KnowledgeDocumentItem(
                provider=document.provider,
                source_id=document.source_id,
                source_name=document.source_name,
                document_id=document.document_id,
                title=document.title,
                node_id=document.node_id,
                parent_id=document.parent_id,
                mime_type=document.mime_type,
                file_extension=document.file_extension,
                source_uri=document.source_uri,
            )
            for document in result.documents
        )

    return KnowledgeListDocumentsResponse(
        documents=documents,
        total_returned=len(documents),
        pagination_scope="per_provider",
        warnings=warnings,
    )
