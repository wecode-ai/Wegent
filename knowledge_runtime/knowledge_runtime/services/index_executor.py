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
from knowledge_runtime.services.content_fetcher import ContentFetcher
from knowledge_runtime.services.resolver import get_resolver
from shared.models import RemoteIndexRequest

logger = logging.getLogger(__name__)


class IndexExecutor:
    """Executes document indexing operations.

    This executor:
    1. Resolves KB reference to full configuration using RuntimeResolver
    2. Fetches binary content from the ContentRef
    3. Creates storage backend and embedding model from resolved configs
    4. Indexes the document using DocumentService
    """

    def __init__(self) -> None:
        self._content_fetcher = ContentFetcher()
        self._resolver = get_resolver()

    async def execute(self, request: RemoteIndexRequest) -> dict[str, Any]:
        """Execute the indexing operation.

        Args:
            request: The index request containing content reference and KB reference.

        Returns:
            Indexing result with chunk_count, doc_ref, etc.

        Raises:
            ValueError: If required configuration is missing.
            ContentFetchError: If content fetching fails.
        """
        # Fetch content from the content reference
        binary_data, source_file, file_extension = await self._content_fetcher.fetch(
            request.content_ref
        )

        # Resolve KB reference to full configuration
        kb_config = self._resolver.resolve_knowledge_base_query_config(
            knowledge_base_id=request.knowledge_base_reference.knowledge_base_id,
            user_id=request.knowledge_base_reference.user_id,
            user_name=request.user_name,
        )

        # Create storage backend from resolved retriever config
        storage_backend = create_storage_backend_from_runtime_config(
            kb_config.retriever_config
        )

        # Create embedding model from resolved config
        embed_model = create_embedding_model_from_runtime_config(
            kb_config.embedding_model_config
        )

        # Create document service
        document_service = DocumentService(storage_backend=storage_backend)

        # Build knowledge_id from knowledge_base_id
        knowledge_id = str(request.knowledge_base_id)

        logger.info(
            f"Indexing document for knowledge_base_id={request.knowledge_base_id}, "
            f"source_file={source_file}, user_id={kb_config.index_owner_user_id}"
        )

        # Index the document
        result = await document_service.index_document_from_binary(
            knowledge_id=knowledge_id,
            binary_data=binary_data,
            source_file=source_file,
            file_extension=file_extension,
            embed_model=embed_model,
            user_id=kb_config.index_owner_user_id,
            splitter_config=request.splitter_config.model_dump(
                mode="json", exclude_none=True
            ),
            document_id=request.document_id,
        )

        logger.info(
            f"Indexing complete: chunk_count={result.get('chunk_count')}, "
            f"doc_ref={result.get('doc_ref')}"
        )

        return result
