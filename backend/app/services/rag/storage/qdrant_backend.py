# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Qdrant storage backend implementation.
"""

from typing import Any, Dict, List, Optional

from llama_index.core.schema import BaseNode

from app.services.rag.storage.base import BaseStorageBackend


class QdrantBackend(BaseStorageBackend):
    """Qdrant storage backend implementation."""

    def __init__(self, config: Dict):
        """Initialize Qdrant backend."""
        super().__init__(config)
        # TODO: Initialize Qdrant client
        raise NotImplementedError("Qdrant backend not yet implemented")

    def get_index_name(self, knowledge_id: str, **kwargs) -> str:
        """Get collection name based on strategy."""
        # TODO: Implement collection naming strategy
        raise NotImplementedError()

    def create_vector_store(self, index_name: str):
        """Create Qdrant vector store."""
        # TODO: Implement Qdrant vector store creation
        raise NotImplementedError()

    def index_with_metadata(
        self,
        nodes: List[BaseNode],
        knowledge_id: str,
        doc_ref: str,
        source_file: str,
        created_at: str,
        embed_model,
        **kwargs,
    ) -> Dict:
        """Add metadata to nodes and index them into Qdrant."""
        # TODO: Implement metadata addition and indexing
        raise NotImplementedError()

    def retrieve(
        self,
        knowledge_id: str,
        query: str,
        embed_model,
        retrieval_setting: Dict[str, Any],
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> Dict:
        """Retrieve nodes from Qdrant."""
        # TODO: Implement retrieval with metadata filtering
        raise NotImplementedError()

    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """Delete document from Qdrant."""
        # TODO: Implement deletion
        raise NotImplementedError()

    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """Get document details from Qdrant."""
        # TODO: Implement document retrieval
        raise NotImplementedError()

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """List documents in Qdrant collection."""
        # TODO: Implement document listing
        raise NotImplementedError()

    def test_connection(self) -> bool:
        """Test connection to Qdrant."""
        # TODO: Implement connection test
        return False
