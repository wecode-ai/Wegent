# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Retrieval service for RAG functionality.
Refactored to use modular architecture with pluggable storage backends.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.knowledge_service import KnowledgeService
from app.services.rag.embedding.factory import create_embedding_model_from_crd
from app.services.rag.retrieval.retriever import DocumentRetriever
from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.storage.factory import create_storage_backend

logger = logging.getLogger(__name__)


class RetrievalService:
    """
    High-level retrieval service.
    Uses modular architecture with pluggable storage backends.
    """

    def __init__(self, storage_backend: Optional[BaseStorageBackend] = None):
        """
        Initialize retrieval service.

        Args:
            storage_backend: Optional storage backend instance (Elasticsearch, Qdrant, etc.)
                           If not provided, must be created from retriever configuration
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

    async def retrieve_from_knowledge_base(
        self,
        query: str,
        knowledge_base_id: int,
        user_id: int,
        db: Session,
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        """
        Retrieve relevant chunks from a knowledge base using its configuration.

        This method encapsulates the logic of:
        1. Fetching knowledge base configuration
        2. Getting retriever CRD
        3. Creating storage backend
        4. Performing retrieval with configured parameters

        Args:
            query: Search query
            knowledge_base_id: Knowledge base ID
            user_id: User ID
            db: Database session
            metadata_condition: Optional metadata filtering conditions

        Returns:
            Dict with retrieval results in Dify-compatible format:
                {
                    "records": [
                        {
                            "content": str,
                            "score": float,
                            "title": str,
                            "metadata": dict
                        }
                    ]
                }

        Raises:
            ValueError: If knowledge base not found, access denied, or configuration invalid
        """
        # Get knowledge base configuration
        kb = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
        )

        if not kb:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} not found or access denied for user {user_id}"
            )

        # Extract retrieval configuration from knowledge base spec
        kb_json = kb.json or {}
        spec = kb_json.get("spec", {})
        retrieval_config = spec.get("retrievalConfig")

        if not retrieval_config:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} has no retrieval configuration"
            )

        # Extract retriever reference
        retriever_name = retrieval_config.get("retriever_name")
        retriever_namespace = retrieval_config.get("retriever_namespace", "default")

        if not retriever_name:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} has incomplete retrieval config (missing retriever_name)"
            )

        logger.info(
            f"[RAG] Using retriever: {retriever_name} (namespace: {retriever_namespace})"
        )

        # Determine the correct user_id for resource lookup
        # For personal resources (namespace='default'), use the KB creator's user_id
        # because the resources belong to the KB creator, not the current user
        # For group resources (namespace!='default'), user_id doesn't matter for lookup
        if retriever_namespace == "default":
            resource_owner_user_id = kb.user_id
        else:
            resource_owner_user_id = user_id

        # Get retriever CRD
        retriever = retriever_kinds_service.get_retriever(
            db=db,
            user_id=resource_owner_user_id,
            name=retriever_name,
            namespace=retriever_namespace,
        )

        if not retriever:
            raise ValueError(
                f"Retriever {retriever_name} (namespace: {retriever_namespace}) not found"
            )

        # Create storage backend from retriever
        storage_backend = create_storage_backend(retriever)
        logger.info(
            f"[RAG] Storage backend created: {storage_backend.__class__.__name__}"
        )

        # Extract embedding model configuration
        embedding_config = retrieval_config.get("embedding_config", {})
        embedding_model_name = embedding_config.get("model_name")
        embedding_model_namespace = embedding_config.get("model_namespace", "default")

        if not embedding_model_name:
            raise ValueError(
                f"Knowledge base {knowledge_base_id} has incomplete embedding config"
            )

        # Determine the correct user_id for embedding model lookup
        # This may differ from retriever_namespace if they use different namespaces
        if embedding_model_namespace == "default":
            embedding_owner_user_id = kb.user_id
        else:
            embedding_owner_user_id = user_id

        # Extract retrieval parameters
        top_k = retrieval_config.get("top_k", 5)
        score_threshold = retrieval_config.get("score_threshold", 0.7)
        retrieval_mode = retrieval_config.get("retrieval_mode", "vector")

        # Extract hybrid weights if in hybrid mode
        vector_weight = None
        keyword_weight = None
        if retrieval_mode == "hybrid":
            hybrid_weights = retrieval_config.get("hybrid_weights", {})
            vector_weight = hybrid_weights.get("vector_weight", 0.7)
            keyword_weight = hybrid_weights.get("keyword_weight", 0.3)

        # Use knowledge base ID as knowledge_id for retrieval
        knowledge_id = str(knowledge_base_id)

        logger.info(
            f"[RAG] Retrieving chunks: knowledge_id={knowledge_id}, "
            f"embedding_model={embedding_model_name}, "
            f"top_k={top_k}, score_threshold={score_threshold}, "
            f"retrieval_mode={retrieval_mode}"
        )

        # Build retrieval_setting dict
        retrieval_setting = {
            "top_k": top_k,
            "score_threshold": score_threshold,
            "retrieval_mode": retrieval_mode,
        }

        # Add hybrid search weights if provided
        if retrieval_mode == "hybrid":
            retrieval_setting["vector_weight"] = vector_weight
            retrieval_setting["keyword_weight"] = keyword_weight

        # Create embedding model from CRD
        # Use embedding_owner_user_id for correct resource lookup
        # For group KBs, the embedding model may be created by other users in the same group
        embed_model = create_embedding_model_from_crd(
            db=db,
            user_id=embedding_owner_user_id,
            model_name=embedding_model_name,
            model_namespace=embedding_model_namespace,
        )

        # Create retriever with storage backend
        retriever_instance = DocumentRetriever(
            storage_backend=storage_backend, embed_model=embed_model
        )

        # Determine the correct user_id for index naming in per_user strategy
        # For personal knowledge bases (namespace="default"), use the current user's ID
        # For group knowledge bases (namespace!="default"), use the KB creator's user_id
        # This ensures all group members access the same index created by the KB owner
        if kb.namespace == "default":
            index_owner_user_id = user_id
        else:
            # Group knowledge base - use KB creator's user_id
            index_owner_user_id = kb.user_id

        # Retrieve documents (run in thread pool to avoid event loop conflicts)
        result = await asyncio.to_thread(
            retriever_instance.retrieve,
            knowledge_id=knowledge_id,
            query=query,
            retrieval_setting=retrieval_setting,
            metadata_condition=metadata_condition,
            user_id=index_owner_user_id,
        )

        return result
