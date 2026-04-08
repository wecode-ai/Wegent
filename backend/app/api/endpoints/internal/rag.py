# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal RAG API endpoints for chat_shell service.

Provides a simplified RAG retrieval endpoint for chat_shell HTTP mode.
These endpoints are intended for service-to-service communication.
"""

import logging
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.services.knowledge.protected_mediation import (
    ProtectedKnowledgeMediationResponse,
    protected_knowledge_mediator,
)
from app.services.knowledge.retrieval_persistence import (
    retrieval_persistence_service,
)
from app.services.rag.gateway_factory import get_query_gateway
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import (
    RemoteRagGateway,
    RemoteRagGatewayError,
    should_fallback_to_local,
)
from app.services.rag.retrieval_service import RetrievalService
from app.services.rag.runtime_resolver import RagRuntimeResolver
from shared.models import (
    RemoteListChunkRecord,
    RemoteListChunksRequest,
    RemoteListChunksResponse,
)

# Constants for document reading pagination
DEFAULT_READ_DOC_LIMIT = 50_000  # Default characters to return
MAX_READ_DOC_LIMIT = 500_000  # Maximum characters allowed per request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rag", tags=["internal-rag"])
runtime_resolver = RagRuntimeResolver()


class DirectInjectionRuntimeContext(BaseModel):
    """Runtime context budget for Backend-side direct injection routing."""

    context_window: Optional[int] = Field(
        default=None,
        ge=1,
        description="Model context window used for routing decisions",
    )
    used_context_tokens: int = Field(
        default=0,
        ge=0,
        description="Approximate tokens already consumed by current conversation messages",
    )
    reserved_output_tokens: int = Field(
        default=4096,
        ge=0,
        description="Tokens reserved for the model output",
    )
    context_buffer_ratio: float = Field(
        default=0.1,
        ge=0.0,
        le=1.0,
        description="Extra context ratio reserved as safety buffer",
    )
    max_direct_chunks: int = Field(
        default=500,
        ge=1,
        description="Maximum chunks allowed for direct injection",
    )


class RetrievePersistenceContext(BaseModel):
    """Persistence context for Backend-side SubtaskContext updates."""

    user_subtask_id: int = Field(
        ...,
        ge=1,
        description="User subtask ID whose knowledge base context should be updated",
    )
    user_id: int = Field(
        ...,
        ge=0,
        description="User ID used when auto-creating the knowledge base context",
    )
    restricted_mode: bool = Field(
        default=False,
        description="Whether the retrieval ran in restricted search-only mode",
    )


class RetrieveMediationContext(BaseModel):
    """Model identity used by Backend-side protected mediation."""

    current_model_name: Optional[str] = Field(
        default=None,
        description="Current answering model name preferred for protected mediation",
    )
    current_model_namespace: Optional[str] = Field(
        default="default",
        description="Namespace of the current answering model",
    )


class InternalRetrieveRequest(BaseModel):
    """Simplified retrieve request for internal use."""

    query: str = Field(..., description="Search query")
    knowledge_base_id: Optional[int] = Field(
        default=None, description="Single knowledge base ID"
    )
    knowledge_base_ids: Optional[list[int]] = Field(
        default=None,
        description="Optional list of knowledge base IDs for all-or-nothing routing",
    )
    max_results: int = Field(default=5, description="Maximum results to return")
    document_ids: Optional[list[int]] = Field(
        default=None,
        description="Optional list of document IDs to filter. Only chunks from these documents will be returned.",
    )
    document_names: Optional[list[str]] = Field(
        default=None,
        description="Optional exact document names to resolve into document IDs before retrieval.",
    )
    route_mode: Literal["auto", "direct_injection", "rag_retrieval"] = Field(
        default="auto",
        description="Routing mode: auto decides in Backend, direct_injection forces all-chunks, rag_retrieval forces standard retrieval",
    )
    user_name: Optional[str] = Field(
        default=None,
        description="User name for placeholder replacement in embedding headers",
    )
    runtime_context: Optional[DirectInjectionRuntimeContext] = Field(
        default=None,
        description="Runtime context budget used by Backend to decide whether direct injection still fits after accounting for the current conversation state",
    )
    persistence_context: Optional[RetrievePersistenceContext] = Field(
        default=None,
        description="Optional SubtaskContext persistence metadata handled entirely in Backend",
    )
    mediation_context: Optional[RetrieveMediationContext] = Field(
        default=None,
        description="Optional model identity used by Backend restricted mediation",
    )

    @model_validator(mode="after")
    def validate_knowledge_base_targets(self):
        """Require at least one KB target and normalize single-id requests."""
        if self.knowledge_base_id is None and not self.knowledge_base_ids:
            raise ValueError("knowledge_base_id or knowledge_base_ids is required")
        return self


class RetrieveRecord(BaseModel):
    """Single retrieval result record."""

    content: str
    score: Optional[float] = None
    title: str
    metadata: Optional[dict] = None
    knowledge_base_id: Optional[int] = None


class InternalRetrieveResponse(BaseModel):
    """Response from internal retrieve endpoint."""

    mode: Literal["direct_injection", "rag_retrieval"]
    records: list[RetrieveRecord]
    total: int
    total_estimated_tokens: int = 0
    message: Optional[str] = None


def _resolve_document_names(
    db: Session,
    knowledge_base_ids: list[int],
    document_names: list[str],
) -> list[int]:
    """Resolve exact document names into document IDs within KB scope."""
    from app.services.knowledge import KnowledgeService

    return KnowledgeService.resolve_document_ids_by_names(
        db=db,
        knowledge_base_ids=knowledge_base_ids,
        document_names=document_names,
    )


def _resolve_query_gateway(runtime_spec):
    route_mode = getattr(runtime_spec, "route_mode", "auto")
    if route_mode == "rag_retrieval":
        return get_query_gateway()
    return LocalRagGateway()


def _finalize_query_runtime_spec(
    runtime_spec,
    db: Session,
    runtime_context: DirectInjectionRuntimeContext | None = None,
):
    if getattr(runtime_spec, "route_mode", "auto") != "auto":
        return runtime_spec
    required_attributes = (
        "query",
        "knowledge_base_ids",
        "document_ids",
        "direct_injection_budget",
        "model_copy",
    )
    if not all(hasattr(runtime_spec, attr) for attr in required_attributes):
        return runtime_spec

    retrieval_service = RetrievalService()
    budget = runtime_context or getattr(runtime_spec, "direct_injection_budget", None)
    resolved_route_mode = retrieval_service.decide_route_mode_for_chat_shell(
        query=runtime_spec.query,
        knowledge_base_ids=runtime_spec.knowledge_base_ids,
        db=db,
        route_mode=runtime_spec.route_mode,
        document_ids=runtime_spec.document_ids,
        metadata_condition=runtime_spec.metadata_condition,
        context_window=budget.context_window if budget else None,
        used_context_tokens=budget.used_context_tokens if budget else 0,
        reserved_output_tokens=budget.reserved_output_tokens if budget else 4096,
        context_buffer_ratio=budget.context_buffer_ratio if budget else 0.1,
        max_direct_chunks=budget.max_direct_chunks if budget else 500,
    )
    return runtime_spec.model_copy(update={"route_mode": resolved_route_mode})


async def _execute_query_with_remote_fallback(runtime_spec, db: Session):
    rag_gateway = _resolve_query_gateway(runtime_spec)
    if (
        isinstance(rag_gateway, RemoteRagGateway)
        and getattr(runtime_spec, "route_mode", None) == "rag_retrieval"
        and not getattr(runtime_spec, "knowledge_base_configs", None)
    ):
        runtime_spec = runtime_spec.model_copy(
            update={
                "knowledge_base_configs": runtime_resolver.build_query_knowledge_base_configs(
                    db=db,
                    knowledge_base_ids=runtime_spec.knowledge_base_ids,
                    user_name=runtime_spec.user_name,
                )
            }
        )
    try:
        return await rag_gateway.query(runtime_spec, db=db)
    except RemoteRagGatewayError as exc:
        if not should_fallback_to_local(exc):
            raise
        logger.warning(
            "[internal_rag] Remote query failed for KBs %s, falling back to local gateway: %s",
            getattr(runtime_spec, "knowledge_base_ids", []),
            exc,
        )
        return await LocalRagGateway().query(runtime_spec, db=db)


@router.post(
    "/retrieve",
    response_model=InternalRetrieveResponse | ProtectedKnowledgeMediationResponse,
)
async def internal_retrieve(
    request: InternalRetrieveRequest,
    db: Session = Depends(get_db),
):
    """
    Internal RAG retrieval endpoint for chat_shell.

    This endpoint provides simplified access to RAG retrieval without
    requiring complex parameters like retriever_ref and embedding_model_ref.
    The knowledge base configuration is read from the KB's spec.

    Args:
        request: Simplified retrieve request with knowledge_base_id
        db: Database session

    Returns:
        Retrieval results with records
    """
    try:
        knowledge_base_ids = request.knowledge_base_ids or []
        if request.knowledge_base_id is not None:
            knowledge_base_ids = [request.knowledge_base_id]

        resolved_document_ids = request.document_ids or []
        if not resolved_document_ids and request.document_names:
            resolved_document_ids = _resolve_document_names(
                db=db,
                knowledge_base_ids=knowledge_base_ids,
                document_names=request.document_names,
            )
            if not resolved_document_ids:
                return InternalRetrieveResponse(
                    mode="rag_retrieval",
                    records=[],
                    total=0,
                    total_estimated_tokens=0,
                    message="Document names not found in the selected knowledge bases. Use kb_ls to inspect available documents first.",
                )

        if resolved_document_ids:
            logger.info(
                "[internal_rag] Filtering by %d documents: %s",
                len(resolved_document_ids),
                resolved_document_ids,
            )

        runtime_context = request.runtime_context
        persistence_context = request.persistence_context
        restricted_mode = bool(
            persistence_context and persistence_context.restricted_mode
        )

        runtime_spec = runtime_resolver.build_query_runtime_spec(
            db=db,
            knowledge_base_ids=knowledge_base_ids,
            query=request.query,
            max_results=request.max_results,
            document_ids=resolved_document_ids or None,
            route_mode=request.route_mode,
            user_id=persistence_context.user_id if persistence_context else None,
            user_name=request.user_name,
            context_window=runtime_context.context_window if runtime_context else None,
            used_context_tokens=(
                runtime_context.used_context_tokens if runtime_context else 0
            ),
            reserved_output_tokens=(
                runtime_context.reserved_output_tokens if runtime_context else 4096
            ),
            context_buffer_ratio=(
                runtime_context.context_buffer_ratio if runtime_context else 0.1
            ),
            max_direct_chunks=(
                runtime_context.max_direct_chunks if runtime_context else 500
            ),
            restricted_mode=restricted_mode,
        )
        runtime_spec = _finalize_query_runtime_spec(runtime_spec, db, runtime_context)
        result = await _execute_query_with_remote_fallback(runtime_spec, db)

        records = result.get("records", [])

        # Calculate total content size for logging
        total_content_chars = sum(len(r.get("content", "")) for r in records)
        total_content_kb = total_content_chars / 1024
        available_for_kb = (
            RetrievalService._calculate_ratio_based_direct_injection_budget(
                runtime_context.context_window if runtime_context else None
            )
        )
        available_injection_tokens = (
            RetrievalService._calculate_available_injection_tokens(
                context_window=(
                    runtime_context.context_window if runtime_context else None
                ),
                used_context_tokens=(
                    runtime_context.used_context_tokens if runtime_context else 0
                ),
                reserved_output_tokens=(
                    runtime_context.reserved_output_tokens if runtime_context else 4096
                ),
                context_buffer_ratio=(
                    runtime_context.context_buffer_ratio if runtime_context else 0.1
                ),
            )
        )

        logger.info(
            "[internal_rag] Retrieved %d records in mode=%s for KBs %s, "
            "total_size=%.2fKB, estimated_tokens=%d, context_window=%s, "
            "used_context_tokens=%s, available_for_kb=%s, "
            "available_injection_tokens=%s, query: %s%s",
            len(records),
            result.get("mode", "rag_retrieval"),
            knowledge_base_ids,
            total_content_kb,
            result.get("total_estimated_tokens", 0),
            runtime_context.context_window if runtime_context else None,
            runtime_context.used_context_tokens if runtime_context else None,
            available_for_kb,
            available_injection_tokens,
            request.query[:50],
            (
                f", filtered by {len(resolved_document_ids)} docs"
                if resolved_document_ids
                else ""
            ),
        )

        mode = result.get("mode", "rag_retrieval")
        total_estimated_tokens = result.get("total_estimated_tokens", 0)

        if persistence_context is not None:
            retrieval_persistence_service.persist_retrieval_result(
                db=db,
                user_subtask_id=persistence_context.user_subtask_id,
                user_id=persistence_context.user_id,
                query=request.query,
                mode=mode,
                records=records,
                restricted_mode=restricted_mode,
            )

        if restricted_mode:
            return await protected_knowledge_mediator.transform(
                db=db,
                query=request.query,
                retrieval_mode=mode,
                records=records,
                mediation_context=(
                    request.mediation_context.model_dump(exclude_none=True)
                    if request.mediation_context
                    else None
                ),
                knowledge_base_ids=knowledge_base_ids,
                total_estimated_tokens=total_estimated_tokens,
                user_id=persistence_context.user_id if persistence_context else None,
                user_name=request.user_name or "system",
            )

        return InternalRetrieveResponse(
            mode=mode,
            records=[
                RetrieveRecord(
                    content=r.get("content", ""),
                    score=r.get("score"),
                    title=r.get("title", "Unknown"),
                    metadata=r.get("metadata"),
                    knowledge_base_id=r.get("knowledge_base_id"),
                )
                for r in records
            ],
            total=len(records),
            total_estimated_tokens=total_estimated_tokens,
            message=result.get("message"),
        )

    except ValueError as e:
        logger.warning("[internal_rag] Retrieval error: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except RemoteRagGatewayError as e:
        logger.warning("[internal_rag] Remote retrieval failed: %s", e)
        raise HTTPException(status_code=e.status_code or 502, detail=str(e)) from e
    except Exception as e:
        logger.error("[internal_rag] Retrieval failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class KnowledgeBaseInfoRequest(BaseModel):
    """Request for getting knowledge base information."""

    knowledge_base_ids: list[int] = Field(..., description="List of knowledge base IDs")


class KnowledgeBaseInfo(BaseModel):
    """Complete information for a single knowledge base.

    Includes size information, configuration, and metadata needed by chat_shell
    for intelligent injection strategy and call limit enforcement.
    """

    id: int
    total_file_size: int  # Total file size in bytes
    document_count: int  # Number of active documents
    estimated_tokens: int  # Estimated token count (file_size / 4)
    max_calls_per_conversation: int  # Maximum tool calls allowed
    exempt_calls_before_check: int  # Calls exempt from token checking
    name: str  # Knowledge base name
    rag_enabled: bool  # Whether RAG retrieval is configured (has retriever)


class KnowledgeBaseInfoResponse(BaseModel):
    """Response for knowledge base info query."""

    items: list[KnowledgeBaseInfo]
    total_file_size: int  # Sum of all KB sizes
    total_estimated_tokens: int  # Sum of all estimated tokens


@router.post("/kb-size", response_model=KnowledgeBaseInfoResponse)
async def get_knowledge_base_info(
    request: KnowledgeBaseInfoRequest,
    db: Session = Depends(get_db),
):
    """
    Get complete information for knowledge bases.

    This endpoint returns size information, configuration, and metadata
    for the specified knowledge bases. Used by chat_shell for:
    1. Deciding whether to use direct injection or RAG retrieval
    2. Enforcing tool call limits per KB configuration
    3. Displaying KB names in logs and UI

    Args:
        request: Request with knowledge base IDs
        db: Database session

    Returns:
        Complete information for each knowledge base
    """
    from app.models.kind import Kind
    from app.services.knowledge import KnowledgeService

    items = []
    total_file_size = 0
    total_estimated_tokens = 0

    for kb_id in request.knowledge_base_ids:
        try:
            # Get file size, extracted text length, and document count in one query
            stats = KnowledgeService.get_active_document_text_length_stats(db, kb_id)
            file_size = stats.file_size_total
            doc_count = stats.active_document_count
            # Estimate tokens using extracted text length (better proxy than raw file size)
            # tested with real cases
            estimated_tokens = int(stats.text_length_total * 1.5)

            # Get KB configuration from Kind spec
            kb_kind = (
                db.query(Kind)
                .filter(Kind.id == kb_id, Kind.kind == "KnowledgeBase")
                .first()
            )

            if kb_kind:
                spec = kb_kind.json.get("spec", {})
                max_calls = spec.get("maxCallsPerConversation", 10)
                exempt_calls = spec.get("exemptCallsBeforeCheck", 5)
                kb_name = spec.get("name", f"KB-{kb_id}")

                # Check if RAG is enabled (has retriever configured)
                retrieval_config = spec.get("retrievalConfig")
                rag_enabled = bool(
                    retrieval_config and retrieval_config.get("retriever_name")
                )

                # Validate config
                if exempt_calls >= max_calls:
                    logger.warning(
                        "[internal_rag] Invalid KB config for KB %d: exempt=%d >= max=%d. Using defaults.",
                        kb_id,
                        exempt_calls,
                        max_calls,
                    )
                    max_calls, exempt_calls = 10, 5
            else:
                # KB not found, use defaults
                logger.warning(
                    "[internal_rag] KB %d not found, using default config", kb_id
                )
                max_calls, exempt_calls, kb_name, rag_enabled = (
                    10,
                    5,
                    f"KB-{kb_id}",
                    False,
                )

            items.append(
                KnowledgeBaseInfo(
                    id=kb_id,
                    total_file_size=file_size,
                    document_count=doc_count,
                    estimated_tokens=estimated_tokens,
                    max_calls_per_conversation=max_calls,
                    exempt_calls_before_check=exempt_calls,
                    name=kb_name,
                    rag_enabled=rag_enabled,
                )
            )

            total_file_size += file_size
            total_estimated_tokens += estimated_tokens

            logger.info(
                "[internal_rag] KB %d info: size=%d bytes, docs=%d, tokens=%d, limits=%d/%d, name=%s, rag_enabled=%s",
                kb_id,
                file_size,
                doc_count,
                estimated_tokens,
                max_calls,
                exempt_calls,
                kb_name,
                rag_enabled,
            )

        except Exception as e:
            logger.warning("[internal_rag] Failed to get info for KB %d: %s", kb_id, e)
            # Add default values for failed KBs
            items.append(
                KnowledgeBaseInfo(
                    id=kb_id,
                    total_file_size=0,
                    document_count=0,
                    estimated_tokens=0,
                    max_calls_per_conversation=10,  # Default
                    exempt_calls_before_check=5,  # Default
                    name=f"KB-{kb_id}",  # Default
                    rag_enabled=False,  # Default to False for failed KBs
                )
            )

    logger.info(
        "[internal_rag] Total KB info: %d bytes, ~%d tokens for %d KBs",
        total_file_size,
        total_estimated_tokens,
        len(request.knowledge_base_ids),
    )

    return KnowledgeBaseInfoResponse(
        items=items,
        total_file_size=total_file_size,
        total_estimated_tokens=total_estimated_tokens,
    )


@router.post("/all-chunks", response_model=RemoteListChunksResponse)
async def get_all_chunks(
    request: RemoteListChunksRequest,
    db: Session = Depends(get_db),
):
    """
    Legacy internal endpoint for fetching all chunks for direct injection.

    This endpoint retrieves all chunks stored in a knowledge base,
    used when the total content fits within the model's context window.

    Args:
        request: Request with knowledge base ID and max chunks
        db: Database session

    Returns:
        All chunks from the knowledge base
    """
    try:
        runtime_spec = runtime_resolver.build_internal_list_chunks_runtime_spec(
            db=db,
            knowledge_base_id=request.knowledge_base_id,
            max_chunks=request.max_chunks,
            query=request.query,
            metadata_condition=request.metadata_condition,
        )
        result = await LocalRagGateway().list_chunks(
            runtime_spec,
            db=db,
        )
        chunks = result.get("chunks", [])

        # Calculate total content size for logging
        total_content_chars = sum(len(c.get("content", "")) for c in chunks)
        total_content_kb = total_content_chars / 1024

        logger.info(
            "[internal_rag] Retrieved all %d chunks from KB %d, total_size=%.2fKB",
            len(chunks),
            request.knowledge_base_id,
            total_content_kb,
        )

        return RemoteListChunksResponse(
            chunks=[
                RemoteListChunkRecord(
                    content=c.get("content", ""),
                    title=c.get("title", "Unknown"),
                    chunk_id=c.get("chunk_id"),
                    doc_ref=c.get("doc_ref"),
                    metadata=c.get("metadata"),
                )
                for c in chunks
            ],
            total=result.get("total", len(chunks)),
        )

    except ValueError as e:
        logger.warning("[internal_rag] All chunks error: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("[internal_rag] All chunks failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============== Document Listing API (kb_ls) ==============


class ListDocsRequest(BaseModel):
    """Request for listing documents in a knowledge base."""

    knowledge_base_id: int = Field(..., description="Knowledge base ID")


class DocItem(BaseModel):
    """Document item with metadata and summary."""

    id: int = Field(..., description="Document ID")
    name: str = Field(..., description="Document name")
    file_extension: str = Field(..., description="File type (pdf, md, txt, etc.)")
    file_size: int = Field(..., description="File size in bytes")
    short_summary: Optional[str] = Field(
        None, description="Short summary (50-100 chars)"
    )
    is_active: bool = Field(..., description="Whether document is indexed")
    created_at: datetime = Field(..., description="Creation timestamp")


class ListDocsResponse(BaseModel):
    """Response for document listing."""

    documents: list[DocItem]
    total: int


@router.post("/list-docs", response_model=ListDocsResponse)
async def list_documents(
    request: ListDocsRequest,
    db: Session = Depends(get_db),
) -> ListDocsResponse:
    """
    List documents in a knowledge base with metadata and summaries.

    Similar to 'ls -l' command. Returns document names, sizes, types,
    and short summaries for AI to explore available content.

    Args:
        request: Request with knowledge base ID
        db: Database session

    Returns:
        List of documents with metadata
    """
    try:
        from app.models.knowledge import KnowledgeDocument

        # Query documents directly (internal API, permission checked at task level)
        documents = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.kind_id == request.knowledge_base_id)
            .order_by(KnowledgeDocument.created_at.desc())
            .all()
        )

        doc_items = []
        for doc in documents:
            # Extract short_summary from summary JSON field
            short_summary = None
            if doc.summary and isinstance(doc.summary, dict):
                short_summary = doc.summary.get("short_summary")

            doc_items.append(
                DocItem(
                    id=doc.id,
                    name=doc.name,
                    file_extension=doc.file_extension or "",
                    file_size=doc.file_size or 0,
                    short_summary=short_summary,
                    is_active=doc.is_active,
                    created_at=doc.created_at,
                )
            )

        logger.info(
            "[internal_rag] Listed %d documents for KB %d",
            len(doc_items),
            request.knowledge_base_id,
        )

        return ListDocsResponse(
            documents=doc_items,
            total=len(doc_items),
        )

    except Exception as e:
        logger.error(
            "[internal_rag] List documents failed for KB %d: %s",
            request.knowledge_base_id,
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(e)) from e


# ============== Document Reading API (kb_head) ==============


class ReadDocRequest(BaseModel):
    """Request for reading document content."""

    document_id: int = Field(..., description="Document ID")
    offset: int = Field(default=0, ge=0, description="Start position in characters")
    limit: int = Field(
        default=DEFAULT_READ_DOC_LIMIT,
        ge=1,
        le=MAX_READ_DOC_LIMIT,
        description="Max characters to return",
    )
    knowledge_base_ids: Optional[list[int]] = Field(
        default=None,
        description="Optional list of allowed KB IDs for security validation",
    )


class ReadDocsRequest(BaseModel):
    """Batch request for reading document content."""

    document_ids: list[int] = Field(..., description="Document IDs")
    offset: int = Field(default=0, ge=0, description="Start position in characters")
    limit: int = Field(
        default=DEFAULT_READ_DOC_LIMIT,
        ge=1,
        le=MAX_READ_DOC_LIMIT,
        description="Max characters to return per document",
    )
    knowledge_base_ids: Optional[list[int]] = Field(
        default=None,
        description="Optional list of allowed KB IDs for security validation",
    )
    persistence_context: Optional[RetrievePersistenceContext] = Field(
        default=None,
        description="Optional kb_head persistence metadata handled in Backend",
    )


class ReadDocResponse(BaseModel):
    """Response for document reading."""

    document_id: int = Field(..., description="Document ID")
    name: str = Field(..., description="Document name")
    content: str = Field(..., description="Document content (partial)")
    total_length: int = Field(..., description="Total document length in characters")
    offset: int = Field(..., description="Actual start position")
    returned_length: int = Field(..., description="Number of characters returned")
    has_more: bool = Field(..., description="Whether more content is available")
    kb_id: Optional[int] = Field(
        default=None, description="Knowledge base ID this document belongs to"
    )


class ReadDocItemResponse(BaseModel):
    """Single item in batch document reading response."""

    id: int = Field(..., description="Document ID")
    name: Optional[str] = Field(default=None, description="Document name")
    content: Optional[str] = Field(
        default=None, description="Document content (partial)"
    )
    total_length: int = Field(default=0, description="Total document length")
    offset: int = Field(default=0, description="Actual start position")
    returned_length: int = Field(default=0, description="Returned content length")
    has_more: bool = Field(default=False, description="Whether more content exists")
    kb_id: Optional[int] = Field(
        default=None, description="Knowledge base ID this document belongs to"
    )
    error: Optional[str] = Field(default=None, description="Per-document error")


class ReadDocsResponse(BaseModel):
    """Response for batch document reading."""

    documents: list[ReadDocItemResponse]
    total: int


@router.post("/read-doc", response_model=ReadDocResponse)
async def read_document(
    request: ReadDocRequest,
    db: Session = Depends(get_db),
) -> ReadDocResponse:
    """
    Read document content with offset/limit pagination.

    Similar to 'head -c' command. Returns partial content starting from
    offset position. Use has_more flag to check if more content exists.

    Args:
        request: Request with document ID, offset, and limit
        db: Database session

    Returns:
        Document content with pagination info
    """
    try:
        from app.services.knowledge.document_read_service import (
            DOCUMENT_READ_ERROR_ACCESS_DENIED,
            DOCUMENT_READ_ERROR_NOT_FOUND,
            document_read_service,
        )

        results = document_read_service.read_documents(
            db=db,
            document_ids=[request.document_id],
            offset=request.offset,
            limit=request.limit,
            knowledge_base_ids=request.knowledge_base_ids,
        )
        result = results[0] if results else None

        if not result or result.get("error_code") == DOCUMENT_READ_ERROR_NOT_FOUND:
            raise HTTPException(status_code=404, detail="Document not found")
        if result.get("error_code") == DOCUMENT_READ_ERROR_ACCESS_DENIED:
            raise HTTPException(
                status_code=403,
                detail="Access denied: document not in allowed knowledge bases",
            )

        logger.info(
            "[internal_rag] Read document %d: offset=%d, returned=%d/%d, has_more=%s",
            request.document_id,
            result.get("offset", 0),
            result.get("returned_length", 0),
            result.get("total_length", 0),
            result.get("has_more", False),
        )

        return ReadDocResponse(
            document_id=result["id"],
            name=result.get("name", ""),
            content=result.get("content", ""),
            total_length=result.get("total_length", 0),
            offset=result.get("offset", 0),
            returned_length=result.get("returned_length", 0),
            has_more=result.get("has_more", False),
            kb_id=result.get("kb_id"),
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "[internal_rag] Read document failed for doc %d: %s",
            request.document_id,
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/read-docs", response_model=ReadDocsResponse)
async def read_documents(
    request: ReadDocsRequest,
    db: Session = Depends(get_db),
) -> ReadDocsResponse:
    """Read multiple documents and optionally persist kb_head usage."""
    try:
        from app.services.knowledge.document_read_service import document_read_service

        persistence_context = request.persistence_context
        results = document_read_service.read_documents(
            db=db,
            document_ids=request.document_ids,
            offset=request.offset,
            limit=request.limit,
            knowledge_base_ids=request.knowledge_base_ids,
            user_subtask_id=(
                persistence_context.user_subtask_id if persistence_context else None
            ),
            user_id=persistence_context.user_id if persistence_context else None,
        )

        logger.info(
            "[internal_rag] Read %d documents in batch: requested=%d, subtask_id=%s",
            len(results),
            len(request.document_ids),
            persistence_context.user_subtask_id if persistence_context else None,
        )

        return ReadDocsResponse(
            documents=[
                ReadDocItemResponse(
                    id=result["id"],
                    name=result.get("name"),
                    content=result.get("content"),
                    total_length=result.get("total_length", 0),
                    offset=result.get("offset", 0),
                    returned_length=result.get("returned_length", 0),
                    has_more=result.get("has_more", False),
                    kb_id=result.get("kb_id"),
                    error=result.get("error"),
                )
                for result in results
            ],
            total=len(results),
        )
    except Exception as e:
        logger.error("[internal_rag] Read documents failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e
