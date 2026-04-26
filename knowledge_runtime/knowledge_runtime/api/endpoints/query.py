# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query endpoint for RAG retrieval operations."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from knowledge_runtime.services.query_executor import QueryExecutor
from shared.db.sync_session import get_db
from shared.models import RemoteQueryRequest, RemoteQueryResponse

router = APIRouter()


@router.post("/query")
async def query_documents(
    request: RemoteQueryRequest,
    db: Session = Depends(get_db),
) -> RemoteQueryResponse:
    """Query documents for RAG retrieval.

    Args:
        request: The query request containing query text and knowledge_base_ids.
        db: Database session for config resolution.

    Returns:
        Query response with ranked records.
    """
    executor = QueryExecutor(db=db)
    return await executor.execute(request)
