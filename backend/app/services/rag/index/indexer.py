# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document indexing orchestration.
"""

from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional, Union

from llama_index.core import SimpleDirectoryReader

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
        Index a document (synchronous).

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
        # Load document
        documents = SimpleDirectoryReader(input_files=[file_path]).load_data()

        # Split documents into nodes
        nodes = self.splitter.split_documents(documents)

        # Prepare metadata
        source_file = Path(file_path).name
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
