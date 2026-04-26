# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index execution service for document indexing operations."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from knowledge_engine.embedding.factory import (
    create_embedding_model_from_runtime_config,
)
from knowledge_engine.services.document_service import DocumentService
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from knowledge_runtime.services.config_resolver import ConfigResolver
from knowledge_runtime.services.content_fetcher import ContentFetcher
from shared.models import RemoteIndexRequest

logger = logging.getLogger(__name__)


class IndexExecutor:
    """Executes document indexing operations.

    This executor:
    1. Resolves configs from the database using ConfigResolver
    2. Fetches binary content from the ContentRef
    3. Creates storage backend and embedding model from resolved configs
    4. Indexes the document using DocumentService
    """

    def __init__(self, db: Session) -> None:
        self._db = db
        self._config_resolver = ConfigResolver()
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
        # Resolve configs from database
        config = self._config_resolver.resolve_index_config(
            db=self._db,
            knowledge_base_id=request.knowledge_base_id,
            user_id=request.user_id,
            document_id=request.document_id,
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

        # Build knowledge_id from knowledge_base_id
        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            "Indexing document for knowledge_base_id=%d, source_file=%s, user_id=%d",
            request.knowledge_base_id,
            source_file,
            config.index_owner_user_id,
        )

        # Index the document
        result = await document_service.index_document_from_binary(
            knowledge_id=knowledge_id,
            binary_data=binary_data,
            source_file=source_file,
            file_extension=file_extension,
            embed_model=embed_model,
            user_id=config.index_owner_user_id,
            splitter_config=config.splitter_config,
            document_id=request.document_id,
        )

        logger.info(
            "Indexing complete: chunk_count=%s, doc_ref=%s",
            result.get("chunk_count"),
            result.get("doc_ref"),
        )

        return result
