# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index endpoint for document indexing operations."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from knowledge_runtime.services.index_executor import IndexExecutor
from shared.models import RemoteIndexRequest

router = APIRouter()


@router.post("/index")
async def index_document(request: RemoteIndexRequest) -> dict[str, Any]:
    """Index a document for RAG retrieval.

    This endpoint:
    1. Fetches content from the provided ContentRef
    2. Creates storage backend and embedding model from configs
    3. Indexes the document chunks into the vector store

    Args:
        request: The index request containing content reference and configs.

    Returns:
        Indexing result with chunk_count, doc_ref, etc.
    """
    executor = IndexExecutor()
    return await executor.execute(request)
