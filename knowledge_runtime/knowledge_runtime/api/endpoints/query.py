# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query endpoint for RAG retrieval operations."""

from __future__ import annotations

from fastapi import APIRouter

from knowledge_runtime.services.query_executor import QueryExecutor
from shared.models import RemoteQueryRequest, RemoteQueryResponse

router = APIRouter()


@router.post("/query")
async def query_documents(request: RemoteQueryRequest) -> RemoteQueryResponse:
    """Query documents for RAG retrieval.

    This endpoint:
    1. Creates storage backends and embedding models for each KB config
    2. Executes the query against each knowledge base
    3. Aggregates and ranks results by score

    Args:
        request: The query request containing query text and KB configs.

    Returns:
        Query response with ranked records.
    """
    executor = QueryExecutor()
    return await executor.execute(request)
