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

        # Use internal method that bypasses user permission check
        # Permission is validated at task level before reaching chat_shell
        result = await retrieval_service.retrieve_from_knowledge_base_internal(
            query=request.query,
            knowledge_base_id=request.knowledge_base_id,
            db=db,
        )

        records = result.get("records", [])

        # Limit results
        records = records[: request.max_results]

        logger.info(
            "[internal_rag] Retrieved %d records for KB %d, query: %s",
            len(records),
            request.knowledge_base_id,
            request.query[:50],
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
