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
    is_user_selected: bool = True,
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
        is_user_selected: Whether KB is explicitly selected by user for this message.
            True = strict mode (user must use KB only)
            False = relaxed mode (KB inherited from task, can use general knowledge)

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
        "[knowledge_factory] Creating KnowledgeBaseTool for %d knowledge bases: %s, "
        "is_user_selected=%s",
        len(knowledge_base_ids),
        knowledge_base_ids,
        is_user_selected,
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

    # Import shared prompt constants
    from app.chat_shell.prompts import KB_PROMPT_RELAXED, KB_PROMPT_STRICT

    # Choose prompt based on whether KB is user-selected or inherited from task
    if is_user_selected:
        # Strict mode: User explicitly selected KB for this message
        kb_instruction = KB_PROMPT_STRICT
        logger.info(
            "[knowledge_factory] Using STRICT mode prompt (user explicitly selected KB)"
        )
    else:
        # Relaxed mode: KB inherited from task, AI can use general knowledge as fallback
        kb_instruction = KB_PROMPT_RELAXED
        logger.info(
            "[knowledge_factory] Using RELAXED mode prompt (KB inherited from task)"
        )

    enhanced_system_prompt = f"{base_system_prompt}{kb_instruction}"

    # Add historical knowledge base meta info if available
    if task_id:
        kb_meta_prompt = _build_historical_kb_meta_prompt(db, task_id)
        if kb_meta_prompt:
            enhanced_system_prompt = f"{enhanced_system_prompt}{kb_meta_prompt}"

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
