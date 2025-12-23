# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document service for RAG functionality.
Refactored to use modular architecture with pluggable storage backends.
"""

import asyncio
import uuid
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.schemas.rag import SplitterConfig
from app.services.rag.embedding.factory import create_embedding_model_from_crd
from app.services.rag.index import DocumentIndexer
from app.services.rag.storage.base import BaseStorageBackend


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
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        db: Session,
        splitter_config: Optional[SplitterConfig] = None,
    ) -> Dict:
        """
        Synchronous document indexing implementation.
        Runs in thread pool to avoid event loop conflicts.

        Args:
            knowledge_id: Knowledge base ID
            file_path: Path to document file
            embedding_model_name: Embedding model name
            embedding_model_namespace: Embedding model namespace
            user_id: User ID
            db: Database session
            splitter_config: Optional splitter configuration

        Returns:
            Indexing result dict
        """
        # Generate document reference ID
        doc_ref = f"doc_{uuid.uuid4().hex[:12]}"

        # Create embedding model from CRD
        embed_model = create_embedding_model_from_crd(
            db=db,
            user_id=user_id,
            model_name=embedding_model_name,
            model_namespace=embedding_model_namespace,
        )

        # Create indexer with storage backend and splitter config
        indexer = DocumentIndexer(
            storage_backend=self.storage_backend,
            embed_model=embed_model,
            splitter_config=splitter_config,
        )

        # Index document (synchronous operation, pass user_id)
        result = indexer.index_document(
            knowledge_id=knowledge_id,
            file_path=file_path,
            doc_ref=doc_ref,
            user_id=user_id,
        )

        return result

    async def index_document(
        self,
        knowledge_id: str,
        file_path: str,
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        db: Session,
        splitter_config: Optional[SplitterConfig] = None,
    ) -> Dict:
        """
        Index a document into storage backend.

        Args:
            knowledge_id: Knowledge base ID
            file_path: Path to document file
            embedding_model_name: Embedding model name
            embedding_model_namespace: Embedding model namespace
            user_id: User ID
            db: Database session
            splitter_config: Optional splitter configuration. If None, defaults to SemanticSplitter

        Returns:
            Indexing result dict with:
                - doc_ref: Generated document reference ID
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
            embedding_model_name,
            embedding_model_namespace,
            user_id,
            db,
            splitter_config,
        )

    async def delete_document(
        self,
        knowledge_id: str,
        doc_ref: str,
        user_id: Optional[int] = None,
    ) -> Dict:
        """
        Delete a document from storage.

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID to delete

        Returns:
            Deletion result dict with:
                - doc_ref: Deleted document reference ID
                - knowledge_id: Knowledge base ID
                - deleted_chunks: Number of chunks deleted
                - status: Deletion status
        """
        # Run in thread pool to avoid uvloop conflicts
        return await asyncio.to_thread(
            self.storage_backend.delete_document,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            user_id=user_id,
        )

    async def list_documents(
        self,
        knowledge_id: str,
        page: int = 1,
        page_size: int = 20,
        user_id: Optional[int] = None,
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
        # Run in thread pool to avoid uvloop conflicts
        return await asyncio.to_thread(
            self.storage_backend.list_documents,
            knowledge_id=knowledge_id,
            page=page,
            page_size=page_size,
            user_id=user_id,
        )

    def test_connection(self) -> bool:
        """
        Test connection to storage backend.

        Returns:
            True if connection successful, False otherwise
        """
        return self.storage_backend.test_connection()
