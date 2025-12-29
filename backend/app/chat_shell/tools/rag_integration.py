# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
RAG integration service for chat functionality.

This module provides functions to retrieve relevant chunks from knowledge bases
and assemble prompts using LlamaIndex native functionality.
"""

import logging
from typing import List, Optional

from llama_index.core.schema import NodeWithScore, TextNode
from sqlalchemy.orm import Session

from app.services.rag.retrieval_service import RetrievalService

logger = logging.getLogger(__name__)


async def retrieve_and_assemble_rag_prompt(
    query: str,
    knowledge_base_ids: List[int],
    user_id: int,
    db: Session,
    max_tokens: int = 8000,
) -> tuple[Optional[str], Optional[List[dict]]]:
    """
    Retrieve relevant chunks from knowledge bases and assemble RAG prompt.

    This is the main entry point for RAG integration in chat. It handles:
    1. Retrieving chunks from each knowledge base using RetrievalService
    2. Assembling prompt using LlamaIndex native Response object
    3. Collecting source references for citation

    Args:
        query: User query
        knowledge_base_ids: List of knowledge base IDs
        user_id: User ID
        db: Database session
        max_tokens: Maximum token count for context (default: 8000)

    Returns:
        Tuple of (assembled RAG prompt string or None, list of source references or None)
        Source references format: [{"index": 1, "title": "filename", "kb_id": 123}, ...]
    """
    if not knowledge_base_ids:
        logger.info("[RAG] No knowledge base IDs provided, skipping RAG")
        return None, None

    logger.info(
        f"[RAG] Starting RAG retrieval for {len(knowledge_base_ids)} knowledge bases: {knowledge_base_ids}"
    )

    # Retrieve chunks from all knowledge bases
    all_nodes = []

    # Create retrieval service (no storage backend needed, will be created per KB)
    retrieval_service = RetrievalService()

    for kb_id in knowledge_base_ids:
        try:
            logger.info(f"[RAG] Processing knowledge base {kb_id}")

            # Retrieve chunks using the new method that encapsulates all configuration logic
            result = await retrieval_service.retrieve_from_knowledge_base(
                query=query,
                knowledge_base_id=kb_id,
                user_id=user_id,
                db=db,
            )

            chunks_count = len(result.get("records", []))
            logger.info(
                f"[RAG] Retrieved {chunks_count} chunks from knowledge base {kb_id}"
            )

            # Convert records to LlamaIndex NodeWithScore objects
            for record in result.get("records", []):
                node = TextNode(
                    text=record.get("content", ""),
                    metadata={
                        "source_file": record.get("title", ""),
                        "score": record.get("score", 0.0),
                        "knowledge_base_id": kb_id,
                        **record.get("metadata", {}),
                    },
                )
                node_with_score = NodeWithScore(
                    node=node,
                    score=record.get("score", 0.0),
                )
                all_nodes.append(node_with_score)

            if chunks_count > 0:
                logger.info(
                    f"[RAG] Successfully converted {chunks_count} chunks to nodes for kb {kb_id}"
                )

        except ValueError as e:
            # Configuration or access errors
            logger.warning(f"[RAG] Failed to retrieve from knowledge base {kb_id}: {e}")
            continue
        except Exception as e:
            logger.error(
                f"[RAG] Unexpected error retrieving from knowledge base {kb_id}: {e}",
                exc_info=True,
            )
            continue

    if not all_nodes:
        logger.warning(
            "[RAG] No chunks retrieved from any knowledge base, returning None"
        )
        return None, None

    logger.info(f"[RAG] Total chunks retrieved: {len(all_nodes)}")

    # Sort by score (descending)
    all_nodes.sort(key=lambda x: x.score or 0.0, reverse=True)
    logger.info(f"[RAG] Sorted {len(all_nodes)} chunks by score (descending)")

    # Deduplicate chunks with same content
    seen_contents = set()
    unique_nodes = []
    for node_with_score in all_nodes:
        content = node_with_score.node.get_content()
        if content not in seen_contents:
            seen_contents.add(content)
            unique_nodes.append(node_with_score)

    logger.info(
        f"[RAG] Deduplication complete: {len(unique_nodes)} unique chunks (from {len(all_nodes)} total)"
    )

    # Build context string from source nodes and collect source references
    # LlamaIndex standard format includes node content with metadata
    context_parts = []
    source_references = []
    current_length = 0
    source_index = 1
    seen_sources = {}  # Track unique sources: (kb_id, source_file) -> index

    for node_with_score in unique_nodes:
        node = node_with_score.node
        score = node_with_score.score or 0.0

        # Get source metadata
        source_file = node.metadata.get("source_file", "Unknown")
        kb_id = node.metadata.get("knowledge_base_id")

        # Track unique sources for citation
        source_key = (kb_id, source_file)
        if source_key not in seen_sources:
            seen_sources[source_key] = source_index
            source_references.append(
                {
                    "index": source_index,
                    "title": source_file,
                    "kb_id": kb_id,
                }
            )
            source_index += 1

        # Format: [Document: filename] (score: 0.95)
        # Content
        chunk_text = (
            f"[Document: {source_file}] (score: {score:.2f})\n{node.get_content()}\n"
        )

        chunk_length = len(chunk_text)
        if current_length + chunk_length > max_tokens * 4:  # Approximate token count
            logger.info(
                f"[RAG] Reached max_tokens limit ({max_tokens}), stopping at {len(context_parts)} chunks"
            )
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

    logger.info(
        f"[RAG] ✅ RAG prompt assembled successfully: {len(context_parts)} chunks included, "
        f"{len(source_references)} unique sources, "
        f"total length={len(rag_prompt)} chars, context length={len(context)} chars"
    )

    return rag_prompt, source_references
