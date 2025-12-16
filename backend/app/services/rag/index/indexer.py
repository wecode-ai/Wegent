# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document indexing orchestration.
"""

from typing import Dict
from pathlib import Path
from datetime import datetime
from llama_index.core import SimpleDirectoryReader

from app.services.rag.index.chunker import DocumentChunker
from app.services.rag.storage.base import BaseStorageBackend


class DocumentIndexer:
    """Orchestrates document indexing process."""

    def __init__(self, storage_backend: BaseStorageBackend, embed_model):
        """
        Initialize document indexer.

        Args:
            storage_backend: Storage backend instance
            embed_model: Embedding model
        """
        self.storage_backend = storage_backend
        self.embed_model = embed_model
        self.chunker = DocumentChunker(embed_model)

    async def index_document(
        self,
        knowledge_id: str,
        file_path: str,
        document_id: str,
        **kwargs
    ) -> Dict:
        """
        Index a document.

        Args:
            knowledge_id: Knowledge base ID
            file_path: Path to document file
            document_id: Document ID
            **kwargs: Additional parameters

        Returns:
            Indexing result dict

        Raises:
            Exception: If indexing fails
        """
        # Load document
        documents = SimpleDirectoryReader(
            input_files=[file_path]
        ).load_data()

        # Chunk documents
        nodes = self.chunker.chunk_documents(documents)

        # Add metadata
        source_file = Path(file_path).name
        created_at = datetime.utcnow().isoformat()
        nodes = self.chunker.add_metadata(
            nodes=nodes,
            knowledge_id=knowledge_id,
            document_id=document_id,
            source_file=source_file,
            created_at=created_at
        )

        # Get index name
        index_name = self.storage_backend.get_index_name(knowledge_id, **kwargs)

        # Index nodes
        result = self.storage_backend.index(
            nodes=nodes,
            index_name=index_name,
            embed_model=self.embed_model
        )

        # Add document info to result
        result.update({
            "document_id": document_id,
            "knowledge_id": knowledge_id,
            "source_file": source_file,
            "chunk_count": len(nodes),
            "created_at": created_at
        })

        return result
