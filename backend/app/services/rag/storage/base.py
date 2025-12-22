# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base storage backend interface for RAG functionality.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from llama_index.core.schema import BaseNode


class BaseStorageBackend(ABC):
    """Abstract base class for storage backends."""

    def __init__(self, config: Dict):
        """
        Initialize storage backend.

        Args:
            config: Storage configuration dict containing:
                - url: Connection URL
                - username: Optional username
                - password: Optional password
                - apiKey: Optional API key
                - indexStrategy: Index naming strategy config
                - ext: Additional provider-specific config
        """
        self.config = config
        self.url = config.get("url")
        self.username = config.get("username")
        self.password = config.get("password")
        self.api_key = config.get("apiKey")
        self.index_strategy = config.get("indexStrategy", {})
        self.ext = config.get("ext", {})

    @abstractmethod
    def get_index_name(self, knowledge_id: str, **kwargs) -> str:
        """
        Get index/collection name based on strategy.

        Args:
            knowledge_id: Knowledge base ID
            **kwargs: Additional parameters

        Returns:
            Index/collection name
        """
        pass

    @abstractmethod
    def create_vector_store(self, index_name: str):
        """
        Create vector store instance.

        Args:
            index_name: Index/collection name

        Returns:
            Vector store instance compatible with LlamaIndex
        """
        pass

    @abstractmethod
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
        """
        Add metadata to nodes and index them into storage.

        Args:
            nodes: List of nodes to index
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)
            source_file: Source file name
            created_at: Creation timestamp
            embed_model: Embedding model
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Indexing result dict with:
                - indexed_count: Number of nodes indexed
                - index_name: Index/collection name
                - status: Indexing status
        """
        pass

    @abstractmethod
    def retrieve(
        self,
        knowledge_id: str,
        query: str,
        embed_model,
        retrieval_setting: Dict[str, Any],
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> Dict:
        """
        Retrieve nodes from storage (Dify-compatible API).

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            embed_model: Embedding model
            retrieval_setting: Dict with keys:
                - top_k: Maximum number of results
                - score_threshold: Minimum similarity score (0-1)
                - retrieval_mode: Optional, 'vector'/'keyword'/'hybrid'
                - vector_weight: Optional, weight for vector search
                - keyword_weight: Optional, weight for keyword search
            metadata_condition: Optional metadata filtering conditions
            **kwargs: Additional parameters

        Returns:
            Dict with Dify-compatible format:
                {
                    "records": [
                        {
                            "content": str,      # Chunk text content
                            "score": float,      # Relevance score (0-1)
                            "title": str,        # Document title/source file
                            "metadata": dict     # Additional metadata
                        }
                    ]
                }
        """
        pass

    @abstractmethod
    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """
        Delete document from storage.

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID
            **kwargs: Additional parameters

        Returns:
            Deletion result dict
        """
        pass

    @abstractmethod
    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """
        Get document details.

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID
            **kwargs: Additional parameters

        Returns:
            Document details dict
        """
        pass

    @abstractmethod
    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """
        List documents in knowledge base.

        Args:
            knowledge_id: Knowledge base ID
            page: Page number
            page_size: Page size
            **kwargs: Additional parameters

        Returns:
            Document list dict
        """
        pass

    @abstractmethod
    def test_connection(self) -> bool:
        """
        Test connection to storage backend.

        Returns:
            True if connection successful, False otherwise
        """
        pass
