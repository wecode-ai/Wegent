# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index execution service for document indexing operations."""

from __future__ import annotations

import logging
from typing import Any

from knowledge_engine.embedding.factory import (
    create_embedding_model_from_runtime_config,
)
from knowledge_engine.services.document_service import DocumentService
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from knowledge_runtime.services.content_fetcher import ContentFetcher
from knowledge_runtime.services.document_index_adapter import (
    DocumentServiceIndexAdapter,
)
from shared.knowledge_module import DocumentIndexRequest, index_document
from shared.models import RemoteIndexRequest

logger = logging.getLogger(__name__)


class IndexExecutor:
    """Executes document indexing operations.

    This executor:
    1. Resolves configs from the database using ConfigResolver
    2. Fetches binary content from the ContentRef
    3. Creates storage backend and embedding model from resolved configs
    4. Indexes the document through the shared module's document interface
    """

    def __init__(self, config_loader: RuntimeConfigLoader | None = None) -> None:
        self._config_loader = config_loader or RuntimeConfigLoader()
        self._content_fetcher = ContentFetcher()

    async def execute(self, request: RemoteIndexRequest) -> dict[str, Any]:
        """Execute the indexing operation.

        Args:
            request: The index request (reference mode - configs resolved from DB).

        Returns:
            Indexing result with chunk_count, doc_ref, etc.

        Raises:
            ValueError: If required configuration is missing.
            ContentFetchError: If content fetching fails.
        """
        # Resolve configs from database, restricted to the resources Backend
        # authorized for this indexing call.
        config = self._config_loader.resolve_index_config(
            knowledge_base_id=request.knowledge_base_id,
            user_id=request.user_id,
            document_id=request.document_id,
            authorized=request.authorized_resources,
        )

        # Fetch content from the content reference
        binary_data, source_file, file_extension = await self._content_fetcher.fetch(
            request.content_ref
        )

        # Override with request-provided metadata if available
        if request.source_file:
            source_file = request.source_file
        if request.file_extension:
            file_extension = request.file_extension

        # Create storage backend and embedding model from resolved configs
        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        embed_model = create_embedding_model_from_runtime_config(
            config.embedding_model_config
        )

        # Create document service
        document_service = DocumentService(storage_backend=storage_backend)

        logger.info(
            "Indexing document for knowledge_base_id=%d, source_file=%s, user_id=%d",
            request.knowledge_base_id,
            source_file,
            config.index_owner_user_id,
        )

        # Index the document through the shared module: the module owns the
        # document identity and result shape, this adapter owns the engine.
        result = await index_document(
            DocumentServiceIndexAdapter(
                document_service=document_service, embed_model=embed_model
            ),
            DocumentIndexRequest(
                knowledge_id=str(request.knowledge_base_id),
                binary_data=binary_data,
                source_file=source_file,
                file_extension=file_extension,
                user_id=config.index_owner_user_id,
                document_id=request.document_id,
                splitter_config=config.splitter_config,
            ),
        )

        logger.info(
            "Indexing complete: chunk_count=%s, doc_ref=%s",
            result.get("chunk_count"),
            result.get("doc_ref"),
        )

        return result
