# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document indexing orchestration.
"""

from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional, Union, List, Optional

from llama_index.core import Document, SimpleDirectoryReader

from app.schemas.rag import SplitterConfig
from app.services.rag.splitter import SemanticSplitter, SentenceSplitter
from app.services.rag.splitter.factory import create_splitter
from app.services.rag.storage.base import BaseStorageBackend


class DocumentIndexer:
    """Orchestrates document indexing process."""

    def __init__(
        self,
        storage_backend: BaseStorageBackend,
        embed_model,
        splitter_config: Optional[SplitterConfig] = None,
    ):
        """
        Initialize document indexer.

        Args:
            storage_backend: Storage backend instance
            embed_model: Embedding model
            splitter_config: Optional splitter configuration. If None, defaults to SemanticSplitter
        """
        self.storage_backend = storage_backend
        self.embed_model = embed_model
        self.splitter = create_splitter(splitter_config, embed_model)

    def index_document(
        self, knowledge_id: str, file_path: str, doc_ref: str, **kwargs
    ) -> Dict:
        """
        Index a document from file path (synchronous).

        This method is synchronous because it's called from asyncio.to_thread()
        in DocumentService to avoid event loop conflicts with LlamaIndex.

        Args:
            knowledge_id: Knowledge base ID
            file_path: Path to document file
            doc_ref: Document reference ID
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Indexing result dict

        Raises:
            Exception: If indexing fails
        """
        # Load document from file
        documents = SimpleDirectoryReader(input_files=[file_path]).load_data()
        source_file = Path(file_path).name

        return self._index_documents(
            documents=documents,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            source_file=source_file,
            **kwargs,
        )

    def index_from_text(
        self,
        knowledge_id: str,
        text_content: str,
        source_file: str,
        doc_ref: str,
        **kwargs,
    ) -> Dict:
        """
        Index a document from pre-extracted text content (synchronous).

        This method allows indexing documents directly from text that was
        already extracted during attachment upload, avoiding redundant
        file parsing and temporary file creation.

        Args:
            knowledge_id: Knowledge base ID
            text_content: Pre-extracted text content from attachment
            source_file: Original filename (used for metadata)
            doc_ref: Document reference ID
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Indexing result dict

        Raises:
            Exception: If indexing fails
        """
        # Create LlamaIndex Document directly from text content
        documents = [
            Document(
                text=text_content,
                metadata={"filename": source_file},
            )
        ]

        return self._index_documents(
            documents=documents,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            source_file=source_file,
            **kwargs,
        )

    def _index_documents(
        self,
        documents: List[Document],
        knowledge_id: str,
        doc_ref: str,
        source_file: str,
        **kwargs,
    ) -> Dict:
        """
        Internal method to index documents.

        Args:
            documents: List of LlamaIndex Document objects
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID
            source_file: Source filename
            **kwargs: Additional parameters

        Returns:
            Indexing result dict
        """
        # Split documents into nodes
        nodes = self.splitter.split_documents(documents)

        # Prepare metadata
        created_at = datetime.now(timezone.utc).isoformat()

        # Delegate to storage backend for metadata addition and indexing
        result = self.storage_backend.index_with_metadata(
            nodes=nodes,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            source_file=source_file,
            created_at=created_at,
            embed_model=self.embed_model,
            **kwargs,
        )

        # Add document info to result
        result.update(
            {
                "doc_ref": doc_ref,
                "knowledge_id": knowledge_id,
                "source_file": source_file,
                "chunk_count": len(nodes),
                "created_at": created_at,
            }
        )

        return result
