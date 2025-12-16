# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document service for RAG functionality.
Refactored to use modular architecture with pluggable storage backends.
"""

import asyncio
import uuid
from typing import Dict

from app.services.rag.index import DocumentIndexer
from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.embedding.factory import create_embedding_model


class DocumentService:
    """
    High-level document management service.
    Uses modular architecture with pluggable storage backends.
    """

    def __init__(self, storage_backend: BaseStorageBackend):
        """
        Initialize document service.

        Args:
            storage_backend: Storage backend instance (Elasticsearch, Qdrant, etc.)
        """
        self.storage_backend = storage_backend

    def _index_document_sync(
        self,
        knowledge_id: str,
        file_path: str,
        embedding_config: dict,
        user_id: int = None,
    ) -> Dict:
        """
        Synchronous document indexing implementation.
        Runs in thread pool to avoid event loop conflicts.

        Args:
            knowledge_id: Knowledge base ID
            file_path: Path to document file
            embedding_config: Embedding model configuration
            user_id: User ID (for per_user index strategy)

        Returns:
            Indexing result dict
        """
        # Generate document ID
        document_id = f"doc_{uuid.uuid4().hex[:12]}"

        # Create embedding model
        embed_model = create_embedding_model(embedding_config)

        # Create indexer with storage backend
        indexer = DocumentIndexer(
            storage_backend=self.storage_backend,
            embed_model=embed_model
        )

        # Index document (synchronous operation, pass user_id)
        result = indexer.index_document(
            knowledge_id=knowledge_id,
            file_path=file_path,
            document_id=document_id,
            user_id=user_id
        )

        return result

    async def index_document(
        self,
        knowledge_id: str,
        file_path: str,
        embedding_config: dict,
        user_id: int = None,
    ) -> Dict:
        """
        Index a document into storage backend.

        Args:
            knowledge_id: Knowledge base ID (replaces dataset_id)
            file_path: Path to document file
            embedding_config: Embedding model configuration dict

        Returns:
            Indexing result dict with:
                - document_id: Generated document ID
                - knowledge_id: Knowledge base ID
                - source_file: Source filename
                - chunk_count: Number of chunks created
                - index_name: Index/collection name
                - status: Indexing status
                - created_at: Creation timestamp

        Raises:
            Exception: If indexing fails
        """
        # Run synchronous indexing in thread pool to avoid uvloop conflicts
        return await asyncio.to_thread(
            self._index_document_sync,
            knowledge_id,
            file_path,
            embedding_config,
            user_id
        )

    async def delete_document(
        self,
        knowledge_id: str,
        document_id: str,
        user_id: int = None,
    ) -> Dict:
        """
        Delete a document from storage.

        Args:
            knowledge_id: Knowledge base ID
            document_id: Document ID to delete

        Returns:
            Deletion result dict with:
                - document_id: Deleted document ID
                - knowledge_id: Knowledge base ID
                - deleted_chunks: Number of chunks deleted
                - status: Deletion status
        """
        return self.storage_backend.delete_document(
            knowledge_id=knowledge_id,
            document_id=document_id,
            user_id=user_id
        )

    async def get_document(
        self,
        knowledge_id: str,
        document_id: str,
        user_id: int = None,
    ) -> Dict:
        """
        Get document details with all chunks.

        Args:
            knowledge_id: Knowledge base ID
            document_id: Document ID

        Returns:
            Document details dict with:
                - document_id: Document ID
                - knowledge_id: Knowledge base ID
                - source_file: Source filename
                - chunk_count: Number of chunks
                - chunks: List of chunk dicts

        Raises:
            ValueError: If document not found
        """
        return self.storage_backend.get_document(
            knowledge_id=knowledge_id,
            document_id=document_id,
            user_id=user_id
        )

    async def list_documents(
        self,
        knowledge_id: str,
        page: int = 1,
        page_size: int = 20,
        user_id: int = None,
    ) -> Dict:
        """
        List documents in knowledge base with pagination.

        Args:
            knowledge_id: Knowledge base ID
            page: Page number (1-indexed)
            page_size: Number of documents per page

        Returns:
            Document list dict with:
                - documents: List of document summary dicts
                - total: Total number of documents
                - page: Current page number
                - page_size: Page size
                - knowledge_id: Knowledge base ID
        """
        return self.storage_backend.list_documents(
            knowledge_id=knowledge_id,
            page=page,
            page_size=page_size,
            user_id=user_id
        )

    def test_connection(self) -> bool:
        """
        Test connection to storage backend.

        Returns:
            True if connection successful, False otherwise
        """
        return self.storage_backend.test_connection()

