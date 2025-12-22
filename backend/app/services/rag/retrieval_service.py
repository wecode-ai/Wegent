# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Retrieval service for RAG functionality.
Refactored to use modular architecture with pluggable storage backends.
"""

import asyncio
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.services.rag.embedding.factory import create_embedding_model_from_crd
from app.services.rag.retrieval import DocumentRetriever
from app.services.rag.storage.base import BaseStorageBackend


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
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        db: Session,
        retrieval_setting: Dict[str, Any],
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        """
        Synchronous retrieval implementation.
        Runs in thread pool to avoid event loop conflicts.

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            embedding_model_name: Embedding model name
            embedding_model_namespace: Embedding model namespace
            user_id: User ID
            db: Database session
            retrieval_setting: Retrieval settings (Dify-style)
            metadata_condition: Optional metadata filtering

        Returns:
            Retrieval result dict
        """
        # Create embedding model from CRD
        embed_model = create_embedding_model_from_crd(
            db=db,
            user_id=user_id,
            model_name=embedding_model_name,
            model_namespace=embedding_model_namespace,
        )

        # Create retriever with storage backend
        retriever = DocumentRetriever(
            storage_backend=self.storage_backend, embed_model=embed_model
        )

        # Retrieve documents (pass user_id)
        result = retriever.retrieve(
            knowledge_id=knowledge_id,
            query=query,
            retrieval_setting=retrieval_setting,
            metadata_condition=metadata_condition,
            user_id=user_id,
        )

        return result

    async def retrieve(
        self,
        query: str,
        knowledge_id: str,
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        db: Session,
        top_k: int = 5,
        score_threshold: float = 0.7,
        retrieval_mode: str = "vector",
        vector_weight: Optional[float] = None,
        keyword_weight: Optional[float] = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        """
        Retrieve relevant document chunks (Dify-compatible API).

        Args:
            query: Search query
            knowledge_id: Knowledge base ID
            embedding_model_name: Embedding model name
            embedding_model_namespace: Embedding model namespace
            user_id: User ID
            db: Database session
            top_k: Maximum number of results
            score_threshold: Minimum similarity score (0-1)
            retrieval_mode: 'vector' or 'hybrid'
            vector_weight: Weight for vector search (hybrid mode only)
            keyword_weight: Weight for BM25 search (hybrid mode only)
            metadata_condition: Optional metadata filtering conditions

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
        # Build retrieval_setting dict (Dify-style API)
        retrieval_setting = {
            "top_k": top_k,
            "score_threshold": score_threshold,
            "retrieval_mode": retrieval_mode,
        }

        # Add hybrid search weights if provided
        if retrieval_mode == "hybrid":
            retrieval_setting["vector_weight"] = (
                vector_weight if vector_weight is not None else 0.7
            )
            retrieval_setting["keyword_weight"] = (
                keyword_weight if keyword_weight is not None else 0.3
            )

        # Run retrieval in thread pool to avoid uvloop conflicts
        return await asyncio.to_thread(
            self._retrieve_sync,
            knowledge_id,
            query,
            embedding_model_name,
            embedding_model_namespace,
            user_id,
            db,
            retrieval_setting,
            metadata_condition,
        )
