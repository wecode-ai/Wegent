# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin execution service for knowledge base management operations."""

from __future__ import annotations

import logging
from typing import Any

from knowledge_engine.services.document_service import DocumentService
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from knowledge_runtime.services.document_index_adapter import (
    DocumentServiceIndexAdapter,
)
from shared.knowledge_module import (
    build_document_delete_request,
    delete_document,
    manage_index,
)
from shared.models import (
    RemoteDeleteDocumentIndexRequest,
    RemoteDropKnowledgeIndexRequest,
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

    def __init__(self, config_loader: RuntimeConfigLoader | None = None) -> None:
        self._config_loader = config_loader or RuntimeConfigLoader()

    @trace_async(
        span_name="delete_document_index",
        tracer_name="knowledge_runtime.services.admin",
    )
    async def delete_document_index(
        self,
        request: RemoteDeleteDocumentIndexRequest,
    ) -> dict[str, Any]:
        """Delete a document's index from a knowledge base."""
        config = self._config_loader.resolve_admin_config(
            knowledge_base_id=request.knowledge_base_id,
            operation="delete",
            authorized=request.authorized_resources,
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

        # The shared module owns the delete identity and the normalized result,
        # so a document leaves exactly the chunks its index call created.
        return await delete_document(
            DocumentServiceIndexAdapter(
                document_service=DocumentService(storage_backend=storage_backend)
            ),
            build_document_delete_request(
                knowledge_id=knowledge_id,
                doc_ref=request.document_ref,
                user_id=config.index_owner_user_id,
            ),
        )

    @trace_async(
        span_name="purge_knowledge_index",
        tracer_name="knowledge_runtime.services.admin",
    )
    async def purge_knowledge_index(
        self,
        request: RemotePurgeKnowledgeIndexRequest,
    ) -> dict[str, Any]:
        """Delete all chunks for a knowledge base."""
        config = self._config_loader.resolve_admin_config(
            knowledge_base_id=request.knowledge_base_id,
            operation="purge",
            authorized=request.authorized_resources,
        )

        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            "Purging knowledge base index: knowledge_base_id=%d",
            request.knowledge_base_id,
        )

        result = await manage_index(
            storage_backend,
            operation="purge",
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
        config = self._config_loader.resolve_admin_config(
            knowledge_base_id=request.knowledge_base_id,
            operation="drop",
            authorized=request.authorized_resources,
        )

        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            "Dropping knowledge base index: knowledge_base_id=%d",
            request.knowledge_base_id,
        )

        result = await manage_index(
            storage_backend,
            operation="drop",
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
        config = self._config_loader.resolve_admin_config(
            knowledge_base_id=request.knowledge_base_id,
            operation="list_chunks",
            authorized=request.authorized_resources,
        )

        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        knowledge_id = str(request.knowledge_base_id)

        result = await manage_index(
            storage_backend,
            operation="list_chunks",
            knowledge_id=knowledge_id,
            max_chunks=request.max_chunks,
            metadata_condition=request.metadata_condition,
            user_id=config.index_owner_user_id,
        )
        return RemoteListChunksResponse.model_validate(result)
