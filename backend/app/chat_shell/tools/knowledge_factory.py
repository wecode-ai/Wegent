# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base tools factory module.

Responsible for creating knowledge base search tools and enhancing system prompts.
"""

import logging
from typing import Any, List, Optional

logger = logging.getLogger(__name__)


def prepare_knowledge_base_tools(
    knowledge_base_ids: Optional[list[int]],
    user_id: int,
    db: Any,
    base_system_prompt: str,
    task_id: Optional[int] = None,
    user_subtask_id: Optional[int] = None,
) -> tuple[list, str]:
    """
    Prepare knowledge base tools and enhanced system prompt.

    This function encapsulates the logic for creating KnowledgeBaseTool
    and enhancing the system prompt with knowledge base instructions.

    Args:
        knowledge_base_ids: Optional list of knowledge base IDs
        user_id: User ID for access control
        db: Database session
        base_system_prompt: Base system prompt to enhance
        task_id: Optional task ID for fetching knowledge base meta from history
        user_subtask_id: Optional user subtask ID for persisting RAG results

    Returns:
        Tuple of (extra_tools list, enhanced_system_prompt string)
    """
    extra_tools = []
    enhanced_system_prompt = base_system_prompt

    if not knowledge_base_ids:
        # Even without current knowledge bases, check for historical KB meta
        if task_id:
            kb_meta_prompt = _build_historical_kb_meta_prompt(db, task_id)
            if kb_meta_prompt:
                enhanced_system_prompt = f"{base_system_prompt}{kb_meta_prompt}"
        return extra_tools, enhanced_system_prompt

    logger.info(
        "[knowledge_factory] Creating KnowledgeBaseTool for %d knowledge bases: %s",
        len(knowledge_base_ids),
        knowledge_base_ids,
    )

    # Import KnowledgeBaseTool
    from app.chat_shell.tools.builtin import KnowledgeBaseTool

    # Create KnowledgeBaseTool with the specified knowledge bases
    # Pass user_subtask_id for persisting RAG results to context database
    kb_tool = KnowledgeBaseTool(
        knowledge_base_ids=knowledge_base_ids,
        user_id=user_id,
        db_session=db,
        user_subtask_id=user_subtask_id,
    )
    extra_tools.append(kb_tool)

    # Enhance system prompt to REQUIRE AI to use the knowledge base tool
    kb_instruction = """

# IMPORTANT: Knowledge Base Requirement

The user has selected specific knowledge bases for this conversation. You MUST use the `knowledge_base_search` tool to retrieve information from these knowledge bases before answering any questions.

## Required Workflow:
1. **ALWAYS** call `knowledge_base_search` first with the user's query
2. Wait for the search results
3. Base your answer **ONLY** on the retrieved information
4. If the search returns no results or irrelevant information, clearly state: "I cannot find relevant information in the selected knowledge base to answer this question."
5. **DO NOT** use your general knowledge or make assumptions beyond what's in the knowledge base

## Critical Rules:
- You MUST search the knowledge base for EVERY user question
- You MUST NOT answer without searching first
- You MUST NOT make up information if the knowledge base doesn't contain it
- If unsure, search again with different keywords

The user expects answers based on the selected knowledge base content only."""

    enhanced_system_prompt = f"{base_system_prompt}{kb_instruction}"

    # Add historical knowledge base meta info if available
    if task_id:
        kb_meta_prompt = _build_historical_kb_meta_prompt(db, task_id)
        if kb_meta_prompt:
            enhanced_system_prompt = f"{enhanced_system_prompt}{kb_meta_prompt}"

    logger.info(
        "[knowledge_factory] Enhanced system prompt with REQUIRED knowledge base usage instructions"
    )

    return extra_tools, enhanced_system_prompt


def _build_historical_kb_meta_prompt(
    db: Any,
    task_id: int,
) -> str:
    """
    Build knowledge base meta information from historical contexts.

    Args:
        db: Database session
        task_id: Task ID

    Returns:
        Formatted prompt string with KB meta info, or empty string
    """
    from app.chat_shell.history.loader import get_knowledge_base_meta_prompt

    try:
        return get_knowledge_base_meta_prompt(db, task_id)
    except Exception as e:
        logger.warning(f"Failed to get KB meta prompt for task {task_id}: {e}")
        return ""


def get_knowledge_base_meta_list(
    db: Any,
    task_id: int,
) -> List[dict]:
    """
    Get list of knowledge base meta information for a task.

    Args:
        db: Database session
        task_id: Task ID

    Returns:
        List of dicts with kb_name and kb_id
    """
    from app.services.context import context_service

    try:
        return context_service.get_knowledge_base_meta_for_task(db, task_id)
    except Exception as e:
        logger.warning(f"Failed to get KB meta list for task {task_id}: {e}")
        return []
