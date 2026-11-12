# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query endpoint for RAG retrieval operations."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header

from knowledge_runtime.services.query_executor import QueryExecutor
from shared.models import RemoteQueryRequest, RemoteQueryResponse

router = APIRouter()


@router.post("/query")
async def query_documents(
    request: RemoteQueryRequest,
    task_id: Annotated[int | None, Header(alias="X-Task-ID")] = None,
) -> RemoteQueryResponse:
    """Query documents for RAG retrieval.

    Args:
        request: The query request containing query text and knowledge_base_ids.

    Returns:
        Query response with ranked records.
    """
    executor = QueryExecutor()
    return await executor.execute(request, task_id=task_id)
