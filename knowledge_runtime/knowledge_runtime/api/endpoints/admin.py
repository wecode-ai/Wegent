# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin endpoints for knowledge base management operations."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from knowledge_runtime.services.admin_executor import AdminExecutor
from shared.models import (
    RemoteDeleteDocumentIndexRequest,
    RemoteDropKnowledgeIndexRequest,
    RemoteListChunksRequest,
    RemoteListChunksResponse,
    RemotePurgeKnowledgeIndexRequest,
    RemoteTestConnectionRequest,
)

router = APIRouter()


@router.post("/delete-document-index")
async def delete_document_index(
    request: RemoteDeleteDocumentIndexRequest,
) -> dict[str, Any]:
    """Delete a document's index from a knowledge base.

    Args:
        request: The delete request.

    Returns:
        Deletion result.
    """
    executor = AdminExecutor()
    return await executor.delete_document_index(request)


@router.post("/purge-knowledge-index")
async def purge_knowledge_index(
    request: RemotePurgeKnowledgeIndexRequest,
) -> dict[str, Any]:
    """Delete all chunks for a knowledge base.

    Args:
        request: The purge request.

    Returns:
        Purge result.
    """
    executor = AdminExecutor()
    return await executor.purge_knowledge_index(request)


@router.post("/drop-knowledge-index")
async def drop_knowledge_index(
    request: RemoteDropKnowledgeIndexRequest,
) -> dict[str, Any]:
    """Physically drop the index/collection for a knowledge base.

    Args:
        request: The drop request.

    Returns:
        Drop result.
    """
    executor = AdminExecutor()
    return await executor.drop_knowledge_index(request)


@router.post("/all-chunks")
async def list_chunks(request: RemoteListChunksRequest) -> RemoteListChunksResponse:
    """List all chunks in a knowledge base.

    Args:
        request: The list request.

    Returns:
        List of chunks.
    """
    executor = AdminExecutor()
    return await executor.list_chunks(request)


@router.post("/test-connection")
async def test_connection(request: RemoteTestConnectionRequest) -> dict[str, Any]:
    """Test connection to a storage backend.

    Args:
        request: The test request.

    Returns:
        Connection test result.
    """
    executor = AdminExecutor()
    return await executor.test_connection(request)
