# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal RAG API endpoints for chat_shell service.

Provides a simplified RAG retrieval endpoint for chat_shell HTTP mode.
These endpoints are intended for service-to-service communication.
"""

import logging
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from shared.telemetry.decorators import trace_async

# Constants for document reading pagination
DEFAULT_READ_DOC_LIMIT = 50_000  # Default characters to return
MAX_READ_DOC_LIMIT = 500_000  # Maximum characters allowed per request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rag", tags=["internal-rag"])


class InternalRetrieveRequest(BaseModel):
    """Simplified retrieve request for internal use."""

    query: str = Field(..., description="Search query")
    knowledge_base_id: int = Field(..., description="Knowledge base ID")
    max_results: int = Field(default=5, description="Maximum results to return")
    document_ids: Optional[list[int]] = Field(
        default=None,
        description="Optional list of document IDs to filter. Only chunks from these documents will be returned.",
    )
    user_name: Optional[str] = Field(
        default=None,
        description="User name for placeholder replacement in embedding headers",
    )


class RetrieveRecord(BaseModel):
    """Single retrieval result record."""

    content: str
    score: float
    title: str
    metadata: Optional[dict] = None


class InternalRetrieveResponse(BaseModel):
    """Response from internal retrieve endpoint."""

    records: list[RetrieveRecord]
    total: int


@router.post("/retrieve", response_model=InternalRetrieveResponse)
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
        from app.services.rag.retrieval_service import RetrievalService

        retrieval_service = RetrievalService()

        # Build metadata_condition for document filtering
        metadata_condition = None
        if request.document_ids:
            # Convert document IDs to doc_ref format (stored as strings in vector DB)
            doc_refs = [str(doc_id) for doc_id in request.document_ids]
            metadata_condition = {
                "operator": "and",
                "conditions": [
                    {
                        "key": "doc_ref",
                        "operator": "in",
                        "value": doc_refs,
                    }
                ],
            }
            logger.info(
                "[internal_rag] Filtering by %d documents: %s",
                len(request.document_ids),
                request.document_ids,
            )

        # Use internal method that bypasses user permission check
        # Permission is validated at task level before reaching chat_shell
        result = await retrieval_service.retrieve_from_knowledge_base_internal(
            query=request.query,
            knowledge_base_id=request.knowledge_base_id,
            db=db,
            metadata_condition=metadata_condition,
            user_name=request.user_name,
        )

        records = result.get("records", [])
        total_records_before_limit = len(records)

        # Calculate total content size for logging
        total_content_chars = sum(len(r.get("content", "")) for r in records)
        total_content_kb = total_content_chars / 1024

        # Limit results
        records = records[: request.max_results]

        logger.info(
            "[internal_rag] Retrieved %d records (limited to %d) for KB %d, "
            "total_size=%.2fKB , query: %s%s",
            total_records_before_limit,
            len(records),
            request.knowledge_base_id,
            total_content_kb,
            request.query[:50],
            (
                f", filtered by {len(request.document_ids)} docs"
                if request.document_ids
                else ""
            ),
        )

        return InternalRetrieveResponse(
            records=[
                RetrieveRecord(
                    content=r.get("content", ""),
                    score=r.get("score", 0.0),
                    title=r.get("title", "Unknown"),
                    metadata=r.get("metadata"),
                )
                for r in records
            ],
            total=len(records),
        )

    except ValueError as e:
        logger.warning("[internal_rag] Retrieval error: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
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


# ============== Unified KB Tool Result Persistence API ==============


class SaveKbToolResultRequest(BaseModel):
    """Unified request for saving KB tool results to context database.

    Supports both RAG retrieval and kb_head tool results.
    The tool_type field determines which service method to use.
    """

    user_subtask_id: int = Field(..., description="User subtask ID")
    knowledge_base_id: int = Field(
        ..., description="Knowledge base ID that was accessed"
    )
    user_id: int = Field(..., description="User ID for context creation if needed")
    tool_type: Literal["rag", "kb_head"] = Field(
        ...,
        description="Tool type: 'rag' for knowledge_base_search, 'kb_head' for kb_head",
    )

    # RAG-specific fields (required when tool_type='rag')
    extracted_text: Optional[str] = Field(
        default=None, description="Concatenated retrieval text (for RAG only)"
    )
    sources: Optional[list[dict]] = Field(
        default=None, description="List of source info dicts (for RAG only)"
    )
    injection_mode: Optional[Literal["direct_injection", "rag_retrieval"]] = Field(
        default=None, description="Injection mode (for RAG only)"
    )
    query: Optional[str] = Field(
        default=None, description="Search query (for RAG only)"
    )
    chunks_count: Optional[int] = Field(
        default=None, ge=0, description="Number of chunks (for RAG only)"
    )

    # kb_head-specific fields (used when tool_type='kb_head')
    # These match KbHeadInput schema for cross-turn content injection
    document_ids: list[int] = Field(
        default_factory=list, description="Document IDs that were read (for kb_head)"
    )
    offset: int = Field(
        default=0, ge=0, description="Start position in characters (for kb_head)"
    )
    limit: int = Field(
        default=50000, ge=1, description="Max characters to return (for kb_head)"
    )


class SaveKbToolResultResponse(BaseModel):
    """Unified response for KB tool result persistence."""

    success: bool
    context_id: Optional[int] = None
    message: str = ""
    # kb_head specific response field
    kb_head_count: Optional[int] = None


@router.post("/save-tool-result", response_model=SaveKbToolResultResponse)
@trace_async(span_name="rag_save_kb_tool_result", tracer_name="internal.rag")
async def save_kb_tool_result(
    request: SaveKbToolResultRequest,
    db: Session = Depends(get_db),
):
    """
    Unified endpoint for saving KB tool results to context database.

    This endpoint handles both RAG retrieval results (knowledge_base_search tool)
    and kb_head tool usage tracking in a single API call.

    If context doesn't exist for the subtask+KB combination, it will be
    created with result data in one operation. This supports the case where
    task-level bound KBs are used in a subtask that didn't explicitly select them.

    The tool_type field determines which service method to use:
    - 'rag': Stores retrieval results (extracted_text, sources, injection_mode, etc.)
    - 'kb_head': Tracks usage statistics (count, chars read, document IDs)

    Args:
        request: Unified request with tool_type and relevant fields
        db: Database session

    Returns:
        Success status and context ID
    """
    try:
        from app.services.context.context_service import context_service

        # First try to find existing context
        context = context_service.get_knowledge_base_context_by_subtask_and_kb_id(
            db=db,
            subtask_id=request.user_subtask_id,
            knowledge_id=request.knowledge_base_id,
        )

        if context is None:
            # Context doesn't exist - create with result data in one operation
            logger.info(
                "[internal_rag] Context not found, creating new for %s: subtask_id=%d, kb_id=%d",
                request.tool_type,
                request.user_subtask_id,
                request.knowledge_base_id,
            )

            # Validate required fields based on tool_type before creating
            if request.tool_type == "rag":
                if (
                    request.injection_mode is None
                    or request.query is None
                    or request.chunks_count is None
                ):
                    return SaveKbToolResultResponse(
                        success=False,
                        message="Missing required fields for RAG: injection_mode, query, chunks_count",
                    )
                # For rag_retrieval mode, extracted_text is required (it contains the actual content)
                if (
                    request.injection_mode == "rag_retrieval"
                    and not request.extracted_text
                ):
                    return SaveKbToolResultResponse(
                        success=False,
                        message="extracted_text is required for rag_retrieval mode",
                    )
                result_data = {
                    "extracted_text": request.extracted_text or "",
                    "sources": request.sources or [],
                    "injection_mode": request.injection_mode,
                    "query": request.query,
                    "chunks_count": request.chunks_count,
                }
            else:  # kb_head
                # Validate that document_ids is not empty for kb_head
                if not request.document_ids:
                    return SaveKbToolResultResponse(
                        success=False,
                        message="document_ids is required for kb_head (at least one document ID)",
                    )
                result_data = {
                    "document_ids": request.document_ids,
                    "offset": request.offset,
                    "limit": request.limit,
                }

            # Create context with result in one operation
            context = context_service.create_knowledge_base_context_with_result(
                db=db,
                subtask_id=request.user_subtask_id,
                knowledge_id=request.knowledge_base_id,
                user_id=request.user_id,
                tool_type=request.tool_type,
                result_data=result_data,
            )

            logger.info(
                "[internal_rag] Created new context with %s result: context_id=%d, subtask_id=%d, kb_id=%d",
                request.tool_type,
                context.id,
                request.user_subtask_id,
                request.knowledge_base_id,
            )

            return SaveKbToolResultResponse(
                success=True,
                context_id=context.id,
                message=f"{request.tool_type} result saved (new context created)",
                kb_head_count=1 if request.tool_type == "kb_head" else None,
            )

        # Context exists - use existing update logic
        if request.tool_type == "rag":
            # Validate RAG-specific required fields
            if (
                request.injection_mode is None
                or request.query is None
                or request.chunks_count is None
            ):
                return SaveKbToolResultResponse(
                    success=False,
                    message="Missing required fields for RAG: injection_mode, query, chunks_count",
                )
            # For rag_retrieval mode, extracted_text is required
            if request.injection_mode == "rag_retrieval" and not request.extracted_text:
                return SaveKbToolResultResponse(
                    success=False,
                    message="extracted_text is required for rag_retrieval mode",
                )

            # Update the context with RAG results
            updated_context = context_service.update_knowledge_base_retrieval_result(
                db=db,
                context_id=context.id,
                extracted_text=request.extracted_text or "",
                sources=request.sources or [],
                injection_mode=request.injection_mode,
                query=request.query,
                chunks_count=request.chunks_count,
            )

            if updated_context:
                logger.info(
                    "[internal_rag] Saved RAG result via unified API: context_id=%d, subtask_id=%d, kb_id=%d, "
                    "injection_mode=%s, chunks_count=%d",
                    updated_context.id,
                    request.user_subtask_id,
                    request.knowledge_base_id,
                    request.injection_mode,
                    request.chunks_count,
                )
                return SaveKbToolResultResponse(
                    success=True,
                    context_id=updated_context.id,
                    message="RAG result saved successfully",
                )

        elif request.tool_type == "kb_head":
            # Validate that document_ids is not empty for kb_head
            if not request.document_ids:
                return SaveKbToolResultResponse(
                    success=False,
                    message="document_ids is required for kb_head (at least one document ID)",
                )
            # Update the context with kb_head usage (append mode - preserve existing data)
            updated_context = context_service.update_knowledge_base_kb_head_result(
                db=db,
                context_id=context.id,
                document_ids=request.document_ids,
                offset=request.offset,
                limit=request.limit,
            )

            if updated_context:
                kb_head_result = (updated_context.type_data or {}).get(
                    "kb_head_result"
                ) or {}
                usage_count = kb_head_result.get("usage_count", 0)
                logger.info(
                    "[internal_rag] Saved kb_head result via unified API: context_id=%d, subtask_id=%d, kb_id=%d, "
                    "usage_count=%d, docs_read=%d",
                    updated_context.id,
                    request.user_subtask_id,
                    request.knowledge_base_id,
                    usage_count,
                    len(request.document_ids),
                )
                return SaveKbToolResultResponse(
                    success=True,
                    context_id=updated_context.id,
                    kb_head_count=usage_count,
                    message="kb_head result saved successfully",
                )

        return SaveKbToolResultResponse(
            success=False,
            message="Failed to update context record",
        )

    except Exception as e:
        logger.error(
            "[internal_rag] Save %s result failed: subtask_id=%d, kb_id=%d, error=%s",
            request.tool_type,
            request.user_subtask_id,
            request.knowledge_base_id,
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(e)) from e


class AllChunksRequest(BaseModel):
    """Request for getting all chunks from a knowledge base."""

    knowledge_base_id: int = Field(..., description="Knowledge base ID")
    max_chunks: int = Field(
        default=10000,
        description="Maximum number of chunks to retrieve (safety limit)",
    )
    query: Optional[str] = Field(
        default=None,
        description="Optional query string for logging purposes",
    )


class ChunkInfo(BaseModel):
    """Information for a single chunk."""

    content: str
    title: str
    chunk_id: Optional[int] = None
    doc_ref: Optional[str] = None
    metadata: Optional[dict] = None


class AllChunksResponse(BaseModel):
    """Response for all chunks query."""

    chunks: list[ChunkInfo]
    total: int


@router.post("/all-chunks", response_model=AllChunksResponse)
async def get_all_chunks(
    request: AllChunksRequest,
    db: Session = Depends(get_db),
):
    """
    Get all chunks from a knowledge base for direct injection.

    This endpoint retrieves all chunks stored in a knowledge base,
    used when the total content fits within the model's context window.

    Args:
        request: Request with knowledge base ID and max chunks
        db: Database session

    Returns:
        All chunks from the knowledge base
    """
    try:
        from app.services.rag.retrieval_service import RetrievalService

        retrieval_service = RetrievalService()

        chunks = await retrieval_service.get_all_chunks_from_knowledge_base(
            knowledge_base_id=request.knowledge_base_id,
            db=db,
            max_chunks=request.max_chunks,
            query=request.query,
        )

        # Calculate total content size for logging
        total_content_chars = sum(len(c.get("content", "")) for c in chunks)
        total_content_kb = total_content_chars / 1024

        logger.info(
            "[internal_rag] Retrieved all %d chunks from KB %d, total_size=%.2fKB",
            len(chunks),
            request.knowledge_base_id,
            total_content_kb,
        )

        return AllChunksResponse(
            chunks=[
                ChunkInfo(
                    content=c.get("content", ""),
                    title=c.get("title", "Unknown"),
                    chunk_id=c.get("chunk_id"),
                    doc_ref=c.get("doc_ref"),
                    metadata=c.get("metadata"),
                )
                for c in chunks
            ],
            total=len(chunks),
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
        from app.models.knowledge import KnowledgeDocument
        from app.services.context import context_service

        # Get document
        document = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == request.document_id)
            .first()
        )

        if not document:
            raise HTTPException(status_code=404, detail="Document not found")

        # Security check: verify document belongs to allowed knowledge bases
        if request.knowledge_base_ids:
            if document.kind_id not in request.knowledge_base_ids:
                logger.warning(
                    "[internal_rag] Access denied: doc %d belongs to KB %d, "
                    "allowed KBs: %s",
                    request.document_id,
                    document.kind_id,
                    request.knowledge_base_ids,
                )
                raise HTTPException(
                    status_code=403,
                    detail="Access denied: document not in allowed knowledge bases",
                )

        # Get content from attachment
        content = ""
        total_length = 0
        actual_start = 0

        if document.attachment_id:
            attachment = context_service.get_context_optional(
                db=db,
                context_id=document.attachment_id,
            )
            if attachment and attachment.extracted_text:
                full_content = attachment.extracted_text
                total_length = len(full_content)

                # Apply offset and limit, clamp start to total_length
                actual_start = min(request.offset, total_length)
                end = min(actual_start + request.limit, total_length)
                content = full_content[actual_start:end]

        returned_length = len(content)
        # Use actual_start instead of request.offset for consistent pagination
        has_more = (actual_start + returned_length) < total_length

        logger.info(
            "[internal_rag] Read document %d: offset=%d, returned=%d/%d, has_more=%s",
            request.document_id,
            actual_start,
            returned_length,
            total_length,
            has_more,
        )

        return ReadDocResponse(
            document_id=document.id,
            name=document.name,
            content=content,
            total_length=total_length,
            offset=actual_start,  # Return actual clamped offset
            returned_length=returned_length,
            has_more=has_more,
            kb_id=document.kind_id,  # Include KB ID for persistence routing
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
