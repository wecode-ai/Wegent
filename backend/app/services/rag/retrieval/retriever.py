# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document retrieval orchestration.
"""

from typing import Any, Dict, Optional

from app.services.rag.storage.base import BaseStorageBackend


class DocumentRetriever:
    """Orchestrates document retrieval process."""

    def __init__(self, storage_backend: BaseStorageBackend, embed_model):
        """
        Initialize document retriever.

        Args:
            storage_backend: Storage backend instance
            embed_model: Embedding model
        """
        self.storage_backend = storage_backend
        self.embed_model = embed_model

    def retrieve(
        self,
        knowledge_id: str,
        query: str,
        retrieval_setting: Dict[str, Any],
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> Dict:
        """
        Retrieve relevant documents (synchronous).

        This method is synchronous because it's called from asyncio.to_thread()
        in RetrievalService to avoid event loop conflicts with LlamaIndex.

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            retrieval_setting: Retrieval settings dict with:
                - top_k: Maximum number of results
                - score_threshold: Minimum similarity score
                - retrieval_mode: Optional 'vector'/'keyword'/'hybrid'
                - vector_weight: Optional weight for vector search
                - keyword_weight: Optional weight for keyword search
            metadata_condition: Optional metadata filtering conditions
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Retrieval result dict
        """
        return self.storage_backend.retrieve(
            knowledge_id=knowledge_id,
            query=query,
            embed_model=self.embed_model,
            retrieval_setting=retrieval_setting,
            metadata_condition=metadata_condition,
            **kwargs,
        )
