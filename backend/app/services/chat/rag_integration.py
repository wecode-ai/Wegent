# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
RAG integration service for chat functionality.

This module provides functions to retrieve relevant chunks from multiple knowledge bases
and assemble prompts using LlamaIndex QueryEngine-style templates.
"""

import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.api.ws.events import KnowledgeBaseRef
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.rag.retrieval_service import RetrievalService
from app.services.rag.storage.factory import create_storage_backend

logger = logging.getLogger(__name__)


class RetrievedChunk:
    """Represents a retrieved document chunk."""

    def __init__(
        self,
        content: str,
        score: float,
        title: str,
        metadata: Dict[str, Any],
        knowledge_id: str,
    ):
        self.content = content
        self.score = score
        self.title = title
        self.metadata = metadata
        self.knowledge_id = knowledge_id


async def retrieve_from_knowledge_bases(
    query: str,
    knowledge_bases: List[KnowledgeBaseRef],
    embedding_model_name: str,
    embedding_model_namespace: str,
    user_id: int,
    db: Session,
) -> List[RetrievedChunk]:
    """
    Retrieve relevant chunks from multiple knowledge bases.

    Each knowledge base uses its own retrieval settings from the associated Retriever CRD.
    Chunks are merged and sorted by relevance score.

    Args:
        query: Search query
        knowledge_bases: List of knowledge base references
        embedding_model_name: Embedding model name
        embedding_model_namespace: Embedding model namespace
        user_id: User ID
        db: Database session

    Returns:
        List of retrieved chunks sorted by score (descending)
    """
    all_chunks: List[RetrievedChunk] = []

    for kb_ref in knowledge_bases:
        try:
            # Get Retriever CRD
            retriever = retriever_kinds_service.get_retriever(
                db=db,
                user_id=user_id,
                name=kb_ref.retriever_name,
                namespace=kb_ref.retriever_namespace,
            )

            # Create storage backend
            storage_backend = create_storage_backend(retriever)

            # Create retrieval service
            retrieval_service = RetrievalService(storage_backend=storage_backend)

            # Get retrieval settings from Retriever spec
            spec = retriever.spec or {}
            retrieval_methods = spec.get("retrievalMethods", {})

            # Determine retrieval mode and weights
            vector_config = retrieval_methods.get("vector", {})
            keyword_config = retrieval_methods.get("keyword", {})
            hybrid_config = retrieval_methods.get("hybrid", {})

            # Default to vector mode if no methods specified
            retrieval_mode = "vector"
            vector_weight = 0.7
            keyword_weight = 0.3

            if hybrid_config.get("enabled", False):
                retrieval_mode = "hybrid"
                vector_weight = vector_config.get("defaultWeight", 0.7)
                keyword_weight = keyword_config.get("defaultWeight", 0.3)
            elif keyword_config.get("enabled", False) and not vector_config.get(
                "enabled", True
            ):
                retrieval_mode = "keyword"

            # Get other retrieval settings (with defaults)
            top_k = spec.get("top_k", 5)
            score_threshold = spec.get("score_threshold", 0.7)

            # Retrieve chunks
            result = await retrieval_service.retrieve(
                query=query,
                knowledge_id=kb_ref.knowledge_id,
                embedding_model_name=embedding_model_name,
                embedding_model_namespace=embedding_model_namespace,
                user_id=user_id,
                db=db,
                top_k=top_k,
                score_threshold=score_threshold,
                retrieval_mode=retrieval_mode,
                vector_weight=vector_weight if retrieval_mode == "hybrid" else None,
                keyword_weight=keyword_weight if retrieval_mode == "hybrid" else None,
            )

            # Convert to RetrievedChunk objects
            for record in result.get("records", []):
                chunk = RetrievedChunk(
                    content=record.get("content", ""),
                    score=record.get("score", 0.0),
                    title=record.get("title", ""),
                    metadata=record.get("metadata", {}),
                    knowledge_id=kb_ref.knowledge_id,
                )
                all_chunks.append(chunk)

        except Exception as e:
            logger.error(
                f"Failed to retrieve from knowledge base {kb_ref.knowledge_id}: {e}",
                exc_info=True,
            )
            continue

    # Sort by score (descending)
    all_chunks.sort(key=lambda x: x.score, reverse=True)

    # Deduplicate chunks with same content
    seen_contents = set()
    unique_chunks = []
    for chunk in all_chunks:
        if chunk.content not in seen_contents:
            seen_contents.add(chunk.content)
            unique_chunks.append(chunk)

    return unique_chunks


def assemble_rag_prompt(
    query: str,
    retrieved_chunks: List[RetrievedChunk],
    max_context_length: int = 8000,
) -> str:
    """
    Assemble prompt using LlamaIndex QueryEngine-style template.

    Format:
        Context information is below.
        -----
        {context}
        -----
        Given the context information and not prior knowledge, answer the query.
        Query: {query}
        Answer:

    Args:
        query: User query
        retrieved_chunks: List of retrieved chunks
        max_context_length: Maximum context length in characters (default: 8000)

    Returns:
        Assembled prompt string
    """
    if not retrieved_chunks:
        # No context available, return query as-is
        return query

    # Build context from chunks
    context_parts = []
    current_length = 0

    for chunk in retrieved_chunks:
        chunk_text = f"[Document: {chunk.title}]\n{chunk.content}\n"
        chunk_length = len(chunk_text)

        if current_length + chunk_length > max_context_length:
            break

        context_parts.append(chunk_text)
        current_length += chunk_length

    context = "\n".join(context_parts)

    # Assemble prompt using LlamaIndex template
    prompt = f"""Context information is below.
-----
{context}
-----
Given the context information and not prior knowledge, answer the query.
Query: {query}
Answer:"""

    return prompt
