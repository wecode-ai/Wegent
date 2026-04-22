# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin execution service for knowledge base management operations."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from knowledge_engine.services.document_service import DocumentService
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from shared.models import (
    RemoteDeleteDocumentIndexRequest,
    RemoteDropKnowledgeIndexRequest,
    RemoteListChunkRecord,
    RemoteListChunksRequest,
    RemoteListChunksResponse,
    RemotePurgeKnowledgeIndexRequest,
    RemoteTestConnectionRequest,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


class AdminExecutor:
    """Executes admin operations for knowledge base management.

    Operations:
    - delete_document_index: Delete a specific document's index
    - purge_knowledge_index: Delete all chunks for a knowledge base
    - drop_knowledge_index: Physically drop the index/collection
    - list_chunks: List all chunks in a knowledge base
    - test_connection: Test storage backend connection
    """

    @trace_async(
        span_name="delete_document_index",
        tracer_name="knowledge_runtime.services.admin",
    )
    async def delete_document_index(
        self,
        request: RemoteDeleteDocumentIndexRequest,
    ) -> dict[str, Any]:
        """Delete a document's index from a knowledge base.

        Args:
            request: The delete request.

        Returns:
            Deletion result.
        """
        storage_backend = create_storage_backend_from_runtime_config(
            request.retriever_config
        )

        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            f"Deleting document index: knowledge_base_id={request.knowledge_base_id}, "
            f"doc_ref={request.document_ref}"
        )

        result = await asyncio.to_thread(
            storage_backend.delete_document,
            knowledge_id=knowledge_id,
            doc_ref=request.document_ref,
            user_id=request.index_owner_user_id,
        )

        return result

    @trace_async(
        span_name="purge_knowledge_index",
        tracer_name="knowledge_runtime.services.admin",
    )
    async def purge_knowledge_index(
        self,
        request: RemotePurgeKnowledgeIndexRequest,
    ) -> dict[str, Any]:
        """Delete all chunks for a knowledge base.

        Args:
            request: The purge request.

        Returns:
            Purge result.
        """
        storage_backend = create_storage_backend_from_runtime_config(
            request.retriever_config
        )

        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            f"Purging knowledge base index: knowledge_base_id={request.knowledge_base_id}"
        )

        result = await asyncio.to_thread(
            storage_backend.delete_knowledge,
            knowledge_id=knowledge_id,
            user_id=request.index_owner_user_id,
        )

        return result

    @trace_async(
        span_name="drop_knowledge_index",
        tracer_name="knowledge_runtime.services.admin",
    )
    async def drop_knowledge_index(
        self,
        request: RemoteDropKnowledgeIndexRequest,
    ) -> dict[str, Any]:
        """Physically drop the index/collection for a knowledge base.

        Args:
            request: The drop request.

        Returns:
            Drop result.
        """
        storage_backend = create_storage_backend_from_runtime_config(
            request.retriever_config
        )

        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            f"Dropping knowledge base index: knowledge_base_id={request.knowledge_base_id}"
        )

        result = await asyncio.to_thread(
            storage_backend.drop_knowledge_index,
            knowledge_id=knowledge_id,
            user_id=request.index_owner_user_id,
        )

        return result

    @trace_async(
        span_name="list_chunks",
        tracer_name="knowledge_runtime.services.admin",
    )
    async def list_chunks(
        self,
        request: RemoteListChunksRequest,
    ) -> RemoteListChunksResponse:
        """List all chunks in a knowledge base.

        Args:
            request: The list request.

        Returns:
            List of chunks.
        """
        storage_backend = create_storage_backend_from_runtime_config(
            request.retriever_config
        )

        knowledge_id = str(request.knowledge_base_id)

        chunks = await asyncio.to_thread(
            storage_backend.get_all_chunks,
            knowledge_id=knowledge_id,
            max_chunks=request.max_chunks,
            metadata_condition=request.metadata_condition,
            user_id=request.index_owner_user_id,
        )

        records = [
            RemoteListChunkRecord(
                content=storage_backend.extract_chunk_text(chunk.get("content", "")),
                title=chunk.get("title", ""),
                chunk_id=chunk.get("chunk_id"),
                doc_ref=chunk.get("doc_ref"),
                metadata=chunk.get("metadata"),
            )
            for chunk in chunks
        ]

        logger.info(
            f"Listed chunks: knowledge_base_id={request.knowledge_base_id}, "
            f"count={len(records)}, max_chunks={request.max_chunks}"
        )

        return RemoteListChunksResponse(
            chunks=records,
            total=len(records),
        )

    @trace_async(
        span_name="test_connection",
        tracer_name="knowledge_runtime.services.admin",
    )
    async def test_connection(
        self,
        request: RemoteTestConnectionRequest,
    ) -> dict[str, Any]:
        """Test connection to a storage backend.

        Args:
            request: The test request.

        Returns:
            Connection test result.
        """
        storage_backend = create_storage_backend_from_runtime_config(
            request.retriever_config
        )

        logger.info("Testing storage backend connection")

        try:
            success = await asyncio.to_thread(storage_backend.test_connection)
            return {
                "success": success,
                "message": "Connection successful" if success else "Connection failed",
            }
        except Exception as e:
            logger.error(f"Connection test failed: {e}")
            return {
                "success": False,
                "message": str(e),
            }
