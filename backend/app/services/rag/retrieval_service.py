# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Retrieval service for RAG functionality.
Refactored to use modular architecture with pluggable storage backends.
"""

import asyncio
from typing import Dict, Any, Optional

from app.services.rag.retrieval import DocumentRetriever
from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.embedding.factory import create_embedding_model


class RetrievalService:
    """
    High-level retrieval service.
    Uses modular architecture with pluggable storage backends.
    """

    def __init__(self, storage_backend: BaseStorageBackend):
        """
        Initialize retrieval service.

        Args:
            storage_backend: Storage backend instance (Elasticsearch, Qdrant, etc.)
        """
        self.storage_backend = storage_backend

    def _retrieve_sync(
        self,
        knowledge_id: str,
        query: str,
        embedding_config: dict,
        retrieval_setting: Dict[str, Any],
        metadata_condition: Optional[Dict[str, Any]] = None,
        user_id: int = None
    ) -> Dict:
        """
        Synchronous retrieval implementation.
        Runs in thread pool to avoid event loop conflicts.

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            embedding_config: Embedding model configuration
            retrieval_setting: Retrieval settings (Dify-style)
            metadata_condition: Optional metadata filtering
            user_id: User ID (for per_user index strategy)

        Returns:
            Retrieval result dict
        """
        # Create embedding model
        embed_model = create_embedding_model(embedding_config)

        # Create retriever with storage backend
        retriever = DocumentRetriever(
            storage_backend=self.storage_backend,
            embed_model=embed_model
        )

        # Retrieve documents (pass user_id)
        result = retriever.retrieve(
            knowledge_id=knowledge_id,
            query=query,
            retrieval_setting=retrieval_setting,
            metadata_condition=metadata_condition,
            user_id=user_id
        )

        return result

    async def retrieve(
        self,
        query: str,
        knowledge_id: str,
        embedding_config: dict,
        top_k: int = 5,
        score_threshold: float = 0.7,
        retrieval_mode: str = "vector",
        vector_weight: Optional[float] = None,
        keyword_weight: Optional[float] = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
        user_id: int = None,
    ) -> Dict:
        """
        Retrieve relevant document chunks.

        Args:
            query: Search query
            knowledge_id: Knowledge base ID (replaces dataset_id)
            embedding_config: Embedding model configuration
            top_k: Maximum number of results
            score_threshold: Minimum similarity score (0-1)
            retrieval_mode: 'vector' or 'hybrid'
            vector_weight: Weight for vector search (hybrid mode only)
            keyword_weight: Weight for BM25 search (hybrid mode only)
            metadata_condition: Optional metadata filtering conditions

        Returns:
            Retrieval results dict with:
                - records: List of retrieved document chunks
                - query: Original query
                - knowledge_id: Knowledge base ID
                - total: Number of results
                - retrieval_mode: Retrieval mode used
        """
        # Build retrieval_setting dict (Dify-style API)
        retrieval_setting = {
            "top_k": top_k,
            "score_threshold": score_threshold,
            "retrieval_mode": retrieval_mode
        }

        # Add hybrid search weights if provided
        if retrieval_mode == "hybrid":
            retrieval_setting["vector_weight"] = vector_weight if vector_weight is not None else 0.7
            retrieval_setting["keyword_weight"] = keyword_weight if keyword_weight is not None else 0.3

        # Run retrieval in thread pool to avoid uvloop conflicts
        return await asyncio.to_thread(
            self._retrieve_sync,
            knowledge_id,
            query,
            embedding_config,
            retrieval_setting,
            metadata_condition,
            user_id
        )
