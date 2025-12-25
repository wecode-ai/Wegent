# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base storage backend interface for RAG functionality.
"""

import hashlib
from abc import ABC, abstractmethod
from typing import Any, ClassVar, Dict, List, Optional

from llama_index.core.schema import BaseNode


class BaseStorageBackend(ABC):
    """Abstract base class for storage backends."""

    # Subclasses should override this with their supported methods
    SUPPORTED_RETRIEVAL_METHODS: ClassVar[List[str]] = []

    # Index name prefix for different storage types (can be overridden)
    INDEX_PREFIX: ClassVar[str] = "index"

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

    def _validate_prefix(self, mode: str) -> str:
        """
        Validate and return prefix for index naming.

        Args:
            mode: Index strategy mode

        Returns:
            Validated prefix string

        Raises:
            ValueError: If prefix is empty or None
        """
        prefix = self.index_strategy.get("prefix", "wegent")
        if not prefix:
            raise ValueError(f"prefix cannot be empty for '{mode}' index strategy mode")
        return prefix

    def _validate_knowledge_id(self, knowledge_id: str, mode: str) -> None:
        """
        Validate knowledge_id is not None or empty.

        Args:
            knowledge_id: Knowledge base ID to validate
            mode: Index strategy mode (for error message)

        Raises:
            ValueError: If knowledge_id is None or empty
        """
        if not knowledge_id:
            raise ValueError(
                f"knowledge_id is required for '{mode}' index strategy mode"
            )

    def get_index_name(self, knowledge_id: str, **kwargs) -> str:
        """
        Get index/collection name based on strategy.

        Strategies:
        - fixed: Use a single fixed index name (requires fixedName)
        - rolling: Use rolling indices based on knowledge_id hash (uses prefix)
        - per_dataset: Use separate index per knowledge base (default)
        - per_user: Use separate index per user (requires user_id)

        Args:
            knowledge_id: Knowledge base ID
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            Index/collection name
        """
        mode = self.index_strategy.get("mode", "per_dataset")

        if mode == "fixed":
            fixed_name = self.index_strategy.get("fixedName")
            if not fixed_name:
                raise ValueError(
                    "fixedName is required for 'fixed' index strategy mode"
                )
            return fixed_name
        elif mode == "rolling":
            # Validate knowledge_id and prefix
            self._validate_knowledge_id(knowledge_id, mode)
            prefix = self._validate_prefix(mode)

            # Validate rollingStep
            step = self.index_strategy.get("rollingStep", 5000)
            if not isinstance(step, int) or step <= 0:
                raise ValueError(f"rollingStep must be a positive integer, got: {step}")

            # Deterministic hash-based sharding using MD5
            hash_val = int(hashlib.md5(knowledge_id.encode()).hexdigest(), 16) % 10000
            index_base = (hash_val // step) * step
            return f"{prefix}_{self.INDEX_PREFIX}_{index_base}"
        elif mode == "per_dataset":
            # Validate knowledge_id and prefix
            self._validate_knowledge_id(knowledge_id, mode)
            prefix = self._validate_prefix(mode)
            return f"{prefix}_kb_{knowledge_id}"
        elif mode == "per_user":
            # Per-user index strategy: separate index for each user
            user_id = kwargs.get("user_id")
            if not user_id:
                raise ValueError(
                    "user_id is required for 'per_user' index strategy mode"
                )
            prefix = self._validate_prefix(mode)
            return f"{prefix}_user_{user_id}"
        else:
            raise ValueError(f"Unknown index strategy mode: {mode}")

    @classmethod
    def get_supported_retrieval_methods(cls) -> List[str]:
        """
        Return list of supported retrieval methods.

        Returns:
            List of method names supported by this backend
        """
        return cls.SUPPORTED_RETRIEVAL_METHODS.copy()

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
