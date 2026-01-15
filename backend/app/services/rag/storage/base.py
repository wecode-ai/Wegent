# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base storage backend interface for RAG functionality.
"""

import json
import logging
from abc import ABC, abstractmethod
from typing import Any, ClassVar, Dict, List, Optional

logger = logging.getLogger(__name__)

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

    def extract_chunk_text(self, raw_content: Any) -> str:
        """Extract normalized plain text from raw chunk content.

        Some storage providers (e.g., LlamaIndex-based backends) may store
        serialized node objects (such as TextNode JSON) in the content field
        when using get_all_chunks. For direct injection we only want the
        human-readable `text` field and should drop internal fields
        (id_, embedding, relationships, etc.).

        This helper attempts to parse such JSON structures and extract the
        `text` value. If parsing fails or the expected structure is missing,
        it falls back to the original content.
        """
        if raw_content is None:
            return ""

        # Most backends already return plain text
        if not isinstance(raw_content, str):
            return str(raw_content)

        stripped = raw_content.strip()
        # Fast path: not a JSON object or does not contain a `text` key
        if not stripped.startswith("{") or '"text"' not in stripped:
            return raw_content

        try:
            data = json.loads(stripped)
        except Exception:
            # If parsing fails, fall back to original content
            return raw_content

        if isinstance(data, dict):
            text = data.get("text")
            if isinstance(text, str):
                return text

        # Fallback: return original content
        return raw_content

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
        - rolling: Use rolling indices based on numeric knowledge_id (uses prefix)
                   Groups N knowledge bases per index, where N = rollingStep (default 10)
                   e.g., step=10: kb_id 1-10 -> index_0, kb_id 11-20 -> index_10, etc.
        - per_dataset: Use separate index per knowledge base (default)
        - per_user: Use separate index per user (requires user_id)

        Args:
            knowledge_id: Knowledge base ID (must be numeric string for rolling mode)
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            Index/collection name
        """
        mode = self.index_strategy.get("mode", "per_dataset")

        # Debug logging for index strategy
        logger.debug(
            f"get_index_name called: knowledge_id={knowledge_id}, "
            f"index_strategy={self.index_strategy}, mode={mode}"
        )

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

            # Validate rollingStep (number of knowledge_ids per index bucket)
            step = self.index_strategy.get("rollingStep", 10)
            if not isinstance(step, int) or step <= 0:
                raise ValueError(f"rollingStep must be a positive integer, got: {step}")

            # Convert knowledge_id to integer for bucket calculation
            # knowledge_id is expected to be a numeric string (e.g., "1", "2", "123")
            try:
                kb_id_num = int(knowledge_id)
            except ValueError:
                raise ValueError(
                    f"knowledge_id must be a numeric value for 'rolling' mode, got: {knowledge_id}"
                )

            # Calculate index base using floor division
            # e.g., step=10: kb_id 1-10 -> index_0, kb_id 11-20 -> index_10, etc.
            # Using (kb_id_num - 1) to make it 0-indexed:
            #   kb_id 1-10 -> bucket 0 -> index_0
            #   kb_id 11-20 -> bucket 1 -> index_10
            bucket_num = (kb_id_num - 1) // step if kb_id_num > 0 else 0
            index_base = bucket_num * step
            index_name = f"{prefix}_{self.INDEX_PREFIX}_{index_base}"

            logger.debug(
                f"Rolling index: step={step}, kb_id_num={kb_id_num}, "
                f"bucket_num={bucket_num}, index_base={index_base}, index_name={index_name}"
            )
            return index_name
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

    @abstractmethod
    def get_all_chunks(
        self, knowledge_id: str, max_chunks: int = 10000, **kwargs
    ) -> List[Dict[str, Any]]:
        """
        Get all chunks from a knowledge base.

        This method retrieves all chunks stored for a specific knowledge base,
        used for direct context injection when content fits within context window.

        Args:
            knowledge_id: Knowledge base ID
            max_chunks: Maximum number of chunks to retrieve (safety limit)
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            List of chunk dicts with:
                - content: str, chunk text content
                - title: str, source document name
                - chunk_id: int, chunk index within document
                - doc_ref: str, document reference ID
                - metadata: dict, additional metadata
        """
        pass
