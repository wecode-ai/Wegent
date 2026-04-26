# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin execution service for knowledge base management operations."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy.orm import Session

from knowledge_engine.services.document_service import DocumentService
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from knowledge_runtime.services.config_resolver import (
    AdminResolvedConfig,
    ConfigResolver,
)
from shared.models import (
    RemoteDeleteDocumentIndexRequest,
    RemoteDropKnowledgeIndexRequest,
    RemoteListChunkRecord,
    RemoteListChunksRequest,
    RemoteListChunksResponse,
    RemotePurgeKnowledgeIndexRequest,
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

    def __init__(self, db: Session) -> None:
        self._db = db
        self._config_resolver = ConfigResolver()

    @trace_async(
        span_name="delete_document_index",
        tracer_name="knowledge_runtime.services.admin",
    )
    async def delete_document_index(
        self,
        request: RemoteDeleteDocumentIndexRequest,
    ) -> dict[str, Any]:
        """Delete a document's index from a knowledge base."""
        config = self._config_resolver.resolve_admin_config(
            self._db,
            knowledge_base_id=request.knowledge_base_id,
        )

        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            "Deleting document index: knowledge_base_id=%d, doc_ref=%s",
            request.knowledge_base_id,
            request.document_ref,
        )

        result = await asyncio.to_thread(
            storage_backend.delete_document,
            knowledge_id=knowledge_id,
            doc_ref=request.document_ref,
            user_id=config.index_owner_user_id,
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
        """Delete all chunks for a knowledge base."""
        config = self._config_resolver.resolve_admin_config(
            self._db,
            knowledge_base_id=request.knowledge_base_id,
        )

        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            "Purging knowledge base index: knowledge_base_id=%d",
            request.knowledge_base_id,
        )

        result = await asyncio.to_thread(
            storage_backend.delete_knowledge,
            knowledge_id=knowledge_id,
            user_id=config.index_owner_user_id,
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
        """Physically drop the index/collection for a knowledge base."""
        config = self._config_resolver.resolve_admin_config(
            self._db,
            knowledge_base_id=request.knowledge_base_id,
        )

        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            "Dropping knowledge base index: knowledge_base_id=%d",
            request.knowledge_base_id,
        )

        result = await asyncio.to_thread(
            storage_backend.drop_knowledge_index,
            knowledge_id=knowledge_id,
            user_id=config.index_owner_user_id,
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
        """List all chunks in a knowledge base."""
        config = self._config_resolver.resolve_admin_config(
            self._db,
            knowledge_base_id=request.knowledge_base_id,
        )

        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        knowledge_id = str(request.knowledge_base_id)

        chunks = await asyncio.to_thread(
            storage_backend.get_all_chunks,
            knowledge_id=knowledge_id,
            max_chunks=request.max_chunks,
            metadata_condition=request.metadata_condition,
            user_id=config.index_owner_user_id,
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
            "Listed chunks: knowledge_base_id=%d, count=%d, max_chunks=%d",
            request.knowledge_base_id,
            len(records),
            request.max_chunks,
        )

        return RemoteListChunksResponse(
            chunks=records,
            total=len(records),
        )
