# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""RAG processor for Chat Service.

This module provides utilities for processing RAG contexts and
knowledge base retrieval for chat messages.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


async def process_rag_if_needed(
    message: str,
    contexts: Optional[List[Any]],
    should_trigger_ai: bool,
    user_id: int,
    db: Session,
) -> Tuple[Optional[Dict], Optional[str]]:
    """
    Process RAG retrieval if contexts with knowledge bases are provided.

    This function:
    1. Extracts knowledge base contexts from payload.contexts
    2. Calls RAG integration service to retrieve and assemble prompt
    3. Returns metadata and RAG prompt separately (does NOT modify message)
    4. The RAG prompt should be used for AI inference, but original message for storage

    Args:
        message: Original user message
        contexts: List of context objects with type and data
        should_trigger_ai: Whether AI should be triggered
        user_id: User ID
        db: Database session

    Returns:
        Tuple of (context_metadata dict for subtask storage, rag_prompt for AI), or (None, None)
    """
    if not contexts or not should_trigger_ai:
        return None, None

    # Filter knowledge_base type contexts
    kb_contexts = [ctx for ctx in contexts if ctx.type == "knowledge_base"]

    if not kb_contexts:
        return None, None

    logger.info(f"Processing RAG with {len(kb_contexts)} knowledge base contexts")

    # Build metadata for subtask storage
    context_metadata = {
        "contexts": [
            {
                "type": ctx.type,
                "data": ctx.data,
            }
            for ctx in contexts
        ],
        "original_query": message,  # Store original query in metadata
    }

    try:
        # Extract knowledge base IDs from context data
        kb_ids = []
        for ctx in kb_contexts:
            try:
                kb_data = ctx.data
                knowledge_id = kb_data.get("knowledge_id")

                # knowledge_id may be string like "kb_001" or int
                if isinstance(knowledge_id, int):
                    kb_ids.append(knowledge_id)
                elif isinstance(knowledge_id, str) and knowledge_id.isdigit():
                    kb_ids.append(int(knowledge_id))
                else:
                    logger.warning(f"Skipping non-numeric knowledge_id: {knowledge_id}")
            except (ValueError, AttributeError, KeyError) as e:
                logger.warning(f"Failed to parse knowledge_id from context: {e}")
                continue

        if not kb_ids:
            logger.warning("No valid knowledge base IDs found")
            return context_metadata, None

        # Retrieve and assemble RAG prompt
        from chat_shell.tools.rag_integration import (
            retrieve_and_assemble_rag_prompt,
        )

        rag_prompt = await retrieve_and_assemble_rag_prompt(
            query=message,
            knowledge_base_ids=kb_ids,
            user_id=user_id,
            db=db,
        )

        if rag_prompt:
            logger.info(f"RAG prompt assembled, length={len(rag_prompt)}")
            # Return RAG prompt separately, do NOT modify message
            return context_metadata, rag_prompt
        else:
            logger.info("RAG retrieved no chunks")
            return context_metadata, None

    except Exception as e:
        logger.error(f"RAG processing failed: {e}", exc_info=True)
        # Continue with original message if RAG fails
        return context_metadata, None


def extract_knowledge_base_ids(context_metadata: Optional[Dict]) -> List[int]:
    """
    Extract knowledge base IDs from context metadata.

    Args:
        context_metadata: Context metadata dict containing contexts

    Returns:
        List of knowledge base IDs
    """
    kb_ids = []
    if not context_metadata:
        return kb_ids

    for ctx in context_metadata.get("contexts", []):
        if ctx.get("type") == "knowledge_base":
            try:
                kb_data = ctx.get("data", {})
                kb_id = kb_data.get("knowledge_id")

                if isinstance(kb_id, int):
                    kb_ids.append(kb_id)
                elif isinstance(kb_id, str) and kb_id.isdigit():
                    kb_ids.append(int(kb_id))
                else:
                    logger.warning(f"Skipping non-numeric knowledge_id: {kb_id}")
            except (ValueError, AttributeError, KeyError) as e:
                logger.warning(f"Failed to parse knowledge_id from context: {e}")
                continue

    return kb_ids


async def process_context_and_rag(
    message: str,
    contexts: Optional[List[Any]],
    should_trigger_ai: bool,
    user_id: int,
    db: Session,
) -> Tuple[Optional[Dict], Optional[str]]:
    """
    Process context metadata and RAG based on chat version.

    This function handles RAG processing differently based on enable_deep_thinking:
    - enable_deep_thinking=True: Only extracts context metadata for tool-based RAG
    - enable_deep_thinking=False: Performs full RAG retrieval and prompt assembly

    For tool-enabled mode, KnowledgeBaseTool will handle retrieval dynamically.

    Args:
        message: Original user message
        contexts: List of context objects
        should_trigger_ai: Whether AI should be triggered
        user_id: User ID
        db: Database session

    Returns:
        Tuple of (context_metadata dict, rag_prompt string or None)
    """
    # For tool-enabled mode: only extract context metadata, no RAG retrieval
    # KnowledgeBaseTool will handle retrieval dynamically
    if contexts and should_trigger_ai:
        context_metadata = {
            "contexts": [
                {
                    "type": ctx.type,
                    "data": ctx.data,
                }
                for ctx in contexts
            ],
            "original_query": message,
        }
        logger.info(
            f"Tool-enabled mode: extracted context metadata with {len(contexts)} contexts"
        )
        return context_metadata, None
    return None, None
