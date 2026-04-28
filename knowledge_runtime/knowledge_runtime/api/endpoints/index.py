# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index endpoint for document indexing operations."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from knowledge_runtime.services.index_executor import IndexExecutor
from shared.db.sync_session import get_db
from shared.models import RemoteIndexRequest

router = APIRouter()


@router.post("/index")
async def index_document(
    request: RemoteIndexRequest,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Index a document for RAG retrieval.

    Args:
        request: The index request containing knowledge_base_id and content_ref.
        db: Database session for config resolution.

    Returns:
        Indexing result with chunk_count, doc_ref, etc.
    """
    executor = IndexExecutor(db=db)
    return await executor.execute(request)
