# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal RAG API endpoints for chat_shell service.

Provides a simplified RAG retrieval endpoint for chat_shell HTTP mode.
These endpoints are intended for service-to-service communication.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_db

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


class KnowledgeBaseSizeRequest(BaseModel):
    """Request for getting knowledge base size."""

    knowledge_base_ids: list[int] = Field(..., description="List of knowledge base IDs")


class KnowledgeBaseSizeInfo(BaseModel):
    """Size information for a single knowledge base."""

    id: int
    total_file_size: int  # Total file size in bytes
    document_count: int  # Number of active documents
    estimated_tokens: int  # Estimated token count (file_size / 4)


class KnowledgeBaseSizeResponse(BaseModel):
    """Response for knowledge base size query."""

    items: list[KnowledgeBaseSizeInfo]
    total_file_size: int  # Sum of all KB sizes
    total_estimated_tokens: int  # Sum of all estimated tokens


@router.post("/kb-size", response_model=KnowledgeBaseSizeResponse)
async def get_knowledge_base_size(
    request: KnowledgeBaseSizeRequest,
    db: Session = Depends(get_db),
):
    """
    Get size information for knowledge bases.

    This endpoint returns the total file size and estimated token count
    for the specified knowledge bases. Used by chat_shell to decide
    whether to use direct injection or RAG retrieval.

    Args:
        request: Request with knowledge base IDs
        db: Database session

    Returns:
        Size information for each knowledge base
    """
    from app.services.knowledge import KnowledgeService

    items = []
    total_file_size = 0
    total_estimated_tokens = 0

    for kb_id in request.knowledge_base_ids:
        try:
            file_size = KnowledgeService.get_total_file_size(db, kb_id)
            doc_count = KnowledgeService.get_active_document_count(db, kb_id)
            # Estimate tokens: approximately 4 characters per token for most models
            estimated_tokens = file_size // 4

            items.append(
                KnowledgeBaseSizeInfo(
                    id=kb_id,
                    total_file_size=file_size,
                    document_count=doc_count,
                    estimated_tokens=estimated_tokens,
                )
            )

            total_file_size += file_size
            total_estimated_tokens += estimated_tokens

            logger.info(
                "[internal_rag] KB %d size: %d bytes, %d docs, ~%d tokens",
                kb_id,
                file_size,
                doc_count,
                estimated_tokens,
            )

        except Exception as e:
            logger.warning("[internal_rag] Failed to get size for KB %d: %s", kb_id, e)
            # Add zero values for failed KBs
            items.append(
                KnowledgeBaseSizeInfo(
                    id=kb_id,
                    total_file_size=0,
                    document_count=0,
                    estimated_tokens=0,
                )
            )

    logger.info(
        "[internal_rag] Total KB size: %d bytes, ~%d tokens for %d KBs",
        total_file_size,
        total_estimated_tokens,
        len(request.knowledge_base_ids),
    )

    return KnowledgeBaseSizeResponse(
        items=items,
        total_file_size=total_file_size,
        total_estimated_tokens=total_estimated_tokens,
    )


class SaveRagResultRequest(BaseModel):
    """Request for saving RAG retrieval results to context database."""

    user_subtask_id: int = Field(..., description="User subtask ID")
    knowledge_base_id: int = Field(
        ..., description="Knowledge base ID that was searched"
    )
    extracted_text: str = Field(..., description="Concatenated retrieval text")
    sources: list[dict] = Field(
        default_factory=list,
        description="List of source info dicts with title, kb_id, score",
    )


class SaveRagResultResponse(BaseModel):
    """Response for save RAG result endpoint."""

    success: bool
    context_id: Optional[int] = None
    message: str = ""


@router.post("/save-result", response_model=SaveRagResultResponse)
async def save_rag_result(
    request: SaveRagResultRequest,
    db: Session = Depends(get_db),
):
    """
    Save RAG retrieval results to context database.

    This endpoint is called by chat_shell in HTTP mode after RAG retrieval
    to persist the results for historical context.

    Args:
        request: Request with subtask ID, KB ID, and retrieval results
        db: Database session

    Returns:
        Success status and context ID if saved
    """
    try:
        from app.services.context.context_service import context_service

        # Find the context record for this subtask and knowledge base
        context = context_service.get_knowledge_base_context_by_subtask_and_kb_id(
            db=db,
            subtask_id=request.user_subtask_id,
            knowledge_id=request.knowledge_base_id,
        )

        if context is None:
            logger.warning(
                "[internal_rag] No context found for subtask_id=%d, kb_id=%d",
                request.user_subtask_id,
                request.knowledge_base_id,
            )
            return SaveRagResultResponse(
                success=False,
                message=f"No context found for subtask_id={request.user_subtask_id}, kb_id={request.knowledge_base_id}",
            )

        # Update the context with RAG results
        updated_context = context_service.update_knowledge_base_retrieval_result(
            db=db,
            context_id=context.id,
            extracted_text=request.extracted_text,
            sources=request.sources,
        )

        if updated_context:
            logger.info(
                "[internal_rag] Saved RAG result: context_id=%d, subtask_id=%d, kb_id=%d, text_length=%d",
                updated_context.id,
                request.user_subtask_id,
                request.knowledge_base_id,
                len(request.extracted_text),
            )
            return SaveRagResultResponse(
                success=True,
                context_id=updated_context.id,
                message="RAG result saved successfully",
            )
        else:
            return SaveRagResultResponse(
                success=False,
                message="Failed to update context record",
            )

    except Exception as e:
        logger.error(
            "[internal_rag] Save RAG result failed: subtask_id=%d, kb_id=%d, error=%s",
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
