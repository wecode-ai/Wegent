# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
RAG integration service for chat functionality.

This module provides functions to retrieve relevant chunks from knowledge bases
and assemble prompts using LlamaIndex native functionality.
"""

import logging
from typing import Dict, List, Optional

from llama_index.core.base.response.schema import Response
from llama_index.core.schema import NodeWithScore, TextNode
from sqlalchemy.orm import Session

from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.knowledge_service import KnowledgeService
from app.services.rag.retrieval_service import RetrievalService
from app.services.rag.storage.factory import create_storage_backend

logger = logging.getLogger(__name__)


async def retrieve_and_assemble_rag_prompt(
    query: str,
    knowledge_base_ids: List[int],
    user_id: int,
    db: Session,
    max_tokens: int = 8000,
) -> Optional[str]:
    """
    Retrieve relevant chunks from knowledge bases and assemble RAG prompt.

    This is the main entry point for RAG integration in chat. It handles:
    1. Fetching knowledge base configurations
    2. Retrieving chunks from each knowledge base
    3. Assembling prompt using LlamaIndex native Response object

    Args:
        query: User query
        knowledge_base_ids: List of knowledge base IDs
        user_id: User ID
        db: Database session
        max_tokens: Maximum token count for context (default: 8000)

    Returns:
        Assembled RAG prompt string, or None if no chunks retrieved
    """
    if not knowledge_base_ids:
        return None

    # Retrieve chunks from all knowledge bases
    all_nodes = []

    for kb_id in knowledge_base_ids:
        try:
            # Get knowledge base configuration
            kb = KnowledgeService.get_knowledge_base(
                db=db,
                knowledge_base_id=kb_id,
                user_id=user_id,
            )

            if not kb:
                logger.warning(
                    f"Knowledge base {kb_id} not found or access denied for user {user_id}"
                )
                continue

            # Extract retrieval configuration from knowledge base spec
            spec = kb.json.get("spec", {})
            retrieval_config = spec.get("retrievalConfig")

            if not retrieval_config:
                logger.warning(
                    f"Knowledge base {kb_id} has no retrieval configuration, skipping"
                )
                continue

            # Extract retriever reference
            retriever_name = retrieval_config.get("retriever_name")
            retriever_namespace = retrieval_config.get("retriever_namespace", "default")

            if not retriever_name:
                logger.warning(
                    f"Knowledge base {kb_id} has incomplete retrieval config (missing retriever_name)"
                )
                continue

            # Get retriever CRD
            retriever = retriever_kinds_service.get_retriever(
                db=db,
                user_id=user_id,
                name=retriever_name,
                namespace=retriever_namespace,
            )

            if not retriever:
                logger.warning(
                    f"Retriever {retriever_name} (namespace: {retriever_namespace}) not found"
                )
                continue

            # Create storage backend
            storage_backend = create_storage_backend(retriever)

            # Create retrieval service
            retrieval_service = RetrievalService(storage_backend=storage_backend)

            # Extract embedding model configuration
            embedding_config = retrieval_config.get("embedding_config", {})
            embedding_model_name = embedding_config.get("model_name")
            embedding_model_namespace = embedding_config.get("model_namespace", "default")

            if not embedding_model_name:
                logger.warning(
                    f"Knowledge base {kb_id} has incomplete embedding config, skipping"
                )
                continue

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

            # Use knowledge base name as knowledge_id for retrieval
            kb_name = spec.get("name", f"kb_{kb_id}")

            # Retrieve chunks
            result = await retrieval_service.retrieve(
                query=query,
                knowledge_id=kb_name,
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

            # Convert records to LlamaIndex NodeWithScore objects
            for record in result.get("records", []):
                node = TextNode(
                    text=record.get("content", ""),
                    metadata={
                        "source_file": record.get("title", ""),
                        "score": record.get("score", 0.0),
                        "knowledge_base_id": kb_id,
                        "knowledge_base_name": kb_name,
                        **record.get("metadata", {}),
                    },
                )
                node_with_score = NodeWithScore(
                    node=node,
                    score=record.get("score", 0.0),
                )
                all_nodes.append(node_with_score)

            logger.info(
                f"Retrieved {len(result.get('records', []))} chunks from knowledge base {kb_id}"
            )

        except Exception as e:
            logger.error(
                f"Failed to retrieve from knowledge base {kb_id}: {e}",
                exc_info=True,
            )
            continue

    if not all_nodes:
        logger.info("No chunks retrieved from any knowledge base")
        return None

    # Sort by score (descending)
    all_nodes.sort(key=lambda x: x.score or 0.0, reverse=True)

    # Deduplicate chunks with same content
    seen_contents = set()
    unique_nodes = []
    for node_with_score in all_nodes:
        content = node_with_score.node.get_content()
        if content not in seen_contents:
            seen_contents.add(content)
            unique_nodes.append(node_with_score)

    logger.info(
        f"Total unique chunks after deduplication: {len(unique_nodes)} (from {len(all_nodes)} total)"
    )

    # Use LlamaIndex Response object to assemble prompt
    # This uses the native LlamaIndex prompt template
    response = Response(
        response="",  # Empty response as we only need the prompt
        source_nodes=unique_nodes,
    )

    # Build context string from source nodes
    # LlamaIndex standard format includes node content with metadata
    context_parts = []
    current_length = 0

    for node_with_score in unique_nodes:
        node = node_with_score.node
        score = node_with_score.score or 0.0

        # Format: [Document: filename] (score: 0.95)
        # Content
        source_file = node.metadata.get("source_file", "Unknown")
        chunk_text = f"[Document: {source_file}] (score: {score:.2f})\n{node.get_content()}\n"

        chunk_length = len(chunk_text)
        if current_length + chunk_length > max_tokens * 4:  # Approximate token count
            break

        context_parts.append(chunk_text)
        current_length += chunk_length

    context = "\n".join(context_parts)

    # Use LlamaIndex standard RAG prompt template
    rag_prompt = f"""Context information is below.
---------------------
{context}
---------------------
Given the context information and not prior knowledge, answer the query.
Query: {query}
Answer: """

    logger.info(f"Assembled RAG prompt with {len(context_parts)} chunks, length={len(rag_prompt)}")

    return rag_prompt
