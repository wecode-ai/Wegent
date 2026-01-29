# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document service for RAG functionality.
Refactored to use modular architecture with pluggable storage backends.
"""

import asyncio
import logging
import uuid
from typing import Dict, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.schemas.rag import SplitterConfig
from app.services.context import context_service
from app.services.rag.embedding.factory import create_embedding_model_from_crd
from app.services.rag.index import DocumentIndexer
from app.services.rag.storage.base import BaseStorageBackend

logger = logging.getLogger(__name__)


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

    def _get_attachment_binary(
        self, db: Session, attachment_id: int
    ) -> Tuple[bytes, str, str]:
        """
        Get original binary data and metadata from context (attachment type).

        This method retrieves the original binary data from storage (MySQL or
        external storage like S3/MinIO) for RAG indexing.

        Args:
            db: Database session
            attachment_id: Context ID (for attachment type contexts)

        Returns:
            Tuple of (binary_data, filename, file_extension)

        Raises:
            ValueError: If context not found, not ready, or binary data unavailable
        """
        # Query context (attachment type)
        context = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.id == attachment_id,
                SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            )
            .first()
        )

        if not context:
            raise ValueError(f"Attachment context {attachment_id} not found")

        # Check context status
        if context.status != ContextStatus.READY.value:
            raise ValueError(
                f"Attachment context {attachment_id} is not ready (status: {context.status})"
            )

        # Get original binary data from storage (supports MySQL and external storage)
        binary_data = context_service.get_attachment_binary_data(
            db=db,
            context=context,
        )

        if binary_data is None:
            logger.error(
                f"Failed to retrieve binary data for attachment context {attachment_id}, "
                f"storage_backend={context.storage_backend}, "
                f"storage_key={context.storage_key}"
            )
            raise ValueError(
                f"Attachment context {attachment_id} has no binary data available"
            )

        logger.info(
            f"Retrieved binary data for attachment context {attachment_id}: "
            f"filename={context.original_filename}, "
            f"size={len(binary_data)} bytes, "
            f"extension={context.file_extension}"
        )

        return binary_data, context.original_filename, context.file_extension

    def _index_document_sync(
        self,
        knowledge_id: str,
        file_path: Optional[str],
        attachment_id: Optional[int],
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        db: Session,
        splitter_config: Optional[SplitterConfig] = None,
        document_id: Optional[int] = None,
    ) -> Dict:
        """
        Synchronous document indexing implementation.
        Runs in thread pool to avoid event loop conflicts.

        Args:
            knowledge_id: Knowledge base ID
            file_path: Path to document file (optional, mutually exclusive with attachment_id)
            attachment_id: Attachment ID (optional, mutually exclusive with file_path)
            embedding_model_name: Embedding model name
            embedding_model_namespace: Embedding model namespace
            user_id: User ID
            db: Database session
            splitter_config: Optional splitter configuration
            document_id: Optional document ID to use as doc_ref

        Returns:
            Indexing result dict
        """
        if file_path is None and attachment_id is None:
            raise ValueError("Either file_path or attachment_id must be provided")

        # Use document_id as doc_ref if provided, otherwise generate a random one
        if document_id is not None:
            doc_ref = str(document_id)
        else:
            doc_ref = f"doc_{uuid.uuid4().hex[:12]}"

        # Create embedding model from CRD
        embed_model = create_embedding_model_from_crd(
            db=db,
            user_id=user_id,
            model_name=embedding_model_name,
            model_namespace=embedding_model_namespace,
        )

        if attachment_id is not None:
            # Get original binary data from attachment (supports MySQL and external storage)
            binary_data, filename, file_extension = self._get_attachment_binary(
                db, attachment_id
            )

            # Create indexer with file_extension for SmartSplitter to use correct strategy
            # This is critical for .md files to use MarkdownNodeParser
            indexer = DocumentIndexer(
                storage_backend=self.storage_backend,
                embed_model=embed_model,
                splitter_config=splitter_config,
                file_extension=file_extension,
            )

            # Index from binary data directly (indexer handles parsing)
            result = indexer.index_from_binary(
                knowledge_id=knowledge_id,
                binary_data=binary_data,
                source_file=filename,
                file_extension=file_extension,
                doc_ref=doc_ref,
                user_id=user_id,
            )
        else:
            # For file path, extract extension from path
            from pathlib import Path

            file_extension = Path(file_path).suffix.lower() if file_path else None

            # Create indexer with file_extension for SmartSplitter
            indexer = DocumentIndexer(
                storage_backend=self.storage_backend,
                embed_model=embed_model,
                splitter_config=splitter_config,
                file_extension=file_extension,
            )

            # Index from file path
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
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        db: Session,
        file_path: Optional[str] = None,
        attachment_id: Optional[int] = None,
        splitter_config: Optional[SplitterConfig] = None,
        document_id: Optional[int] = None,
    ) -> Dict:
        """
        Index a document into storage backend.

        Args:
            knowledge_id: Knowledge base ID
            embedding_model_name: Embedding model name
            embedding_model_namespace: Embedding model namespace
            user_id: User ID
            db: Database session
            file_path: Path to document file (optional, mutually exclusive with attachment_id)
            attachment_id: Attachment ID (optional, mutually exclusive with file_path)
            splitter_config: Optional splitter configuration. If None, defaults to SemanticSplitter
            document_id: Optional document ID to use as doc_ref

        Returns:
            Indexing result dict with:
                - doc_ref: Document reference ID (document_id if provided, otherwise generated)
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
            attachment_id,
            embedding_model_name,
            embedding_model_namespace,
            user_id,
            db,
            splitter_config,
            document_id,
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
