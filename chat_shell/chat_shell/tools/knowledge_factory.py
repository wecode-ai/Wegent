# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base tools factory module.

Responsible for creating knowledge base search tools and enhancing system prompts.
"""

import logging
from typing import Any, List, Optional

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def prepare_knowledge_base_tools(
    knowledge_base_ids: Optional[list[int]],
    user_id: int,
    db: AsyncSession,
    base_system_prompt: str,
    task_id: Optional[int] = None,
    user_subtask_id: Optional[int] = None,
    is_user_selected: bool = True,
    document_ids: Optional[list[int]] = None,
    context_window: Optional[int] = None,
) -> tuple[list, str]:
    """
    Prepare knowledge base tools and enhanced system prompt.

    This function encapsulates the logic for creating KnowledgeBaseTool
    and enhancing the system prompt with knowledge base instructions.

    Args:
        knowledge_base_ids: Optional list of knowledge base IDs
        user_id: User ID for access control
        db: Async database session
        base_system_prompt: Base system prompt to enhance
        task_id: Optional task ID for fetching knowledge base meta from history
        user_subtask_id: Optional user subtask ID for persisting RAG results
        is_user_selected: Whether KB is explicitly selected by user for this message.
            True = strict mode (user must use KB only)
            False = relaxed mode (KB inherited from task, can use general knowledge)
        document_ids: Optional list of document IDs to filter retrieval.
            When set, only chunks from these specific documents will be returned.
        context_window: Optional context window size from Model CRD.
            Used by KnowledgeBaseTool for injection strategy decisions.

    Returns:
        Tuple of (extra_tools list, enhanced_system_prompt string)
    """
    extra_tools = []
    enhanced_system_prompt = base_system_prompt

    if not knowledge_base_ids:
        # Even without current knowledge bases, check for historical KB meta
        if task_id:
            kb_meta_prompt = await _build_historical_kb_meta_prompt(db, task_id)
            if kb_meta_prompt:
                enhanced_system_prompt = f"{base_system_prompt}{kb_meta_prompt}"
        return extra_tools, enhanced_system_prompt

    logger.info(
        "[knowledge_factory] Creating KnowledgeBaseTool for %d knowledge bases: %s, "
        "is_user_selected=%s, document_ids=%s, context_window=%s",
        len(knowledge_base_ids),
        knowledge_base_ids,
        is_user_selected,
        document_ids,
        context_window,
    )

    # Import KnowledgeBaseTool
    from chat_shell.tools.builtin import KnowledgeBaseTool

    # Create KnowledgeBaseTool with the specified knowledge bases
    # Pass user_subtask_id for persisting RAG results to context database
    # Pass document_ids for filtering to specific documents
    # Pass context_window from Model CRD for injection strategy decisions
    kb_tool = KnowledgeBaseTool(
        knowledge_base_ids=knowledge_base_ids,
        document_ids=document_ids or [],
        user_id=user_id,
        db_session=db,
        user_subtask_id=user_subtask_id,
        context_window=context_window,
    )
    extra_tools.append(kb_tool)

    # Import shared prompt constants from chat_shell prompts module
    from chat_shell.prompts import KB_PROMPT_RELAXED, KB_PROMPT_STRICT

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
        kb_meta_prompt = await _build_historical_kb_meta_prompt(db, task_id)
        if kb_meta_prompt:
            enhanced_system_prompt = f"{enhanced_system_prompt}{kb_meta_prompt}"

    return extra_tools, enhanced_system_prompt


async def _build_historical_kb_meta_prompt(
    db: AsyncSession,
    task_id: int,
) -> str:
    """
    Build knowledge base meta information from historical contexts.

    Args:
        db: Async database session
        task_id: Task ID

    Returns:
        Formatted prompt string with KB meta info, or empty string
    """
    from chat_shell.core.config import settings

    # In HTTP mode, skip KB meta prompt loading since it requires backend's app module
    # which is not available when running as an independent service
    mode = settings.CHAT_SHELL_MODE.lower()
    storage = settings.STORAGE_TYPE.lower()
    if mode == "http" and storage == "remote":
        logger.debug(
            f"[knowledge_factory] Skipping KB meta prompt in HTTP mode for task {task_id}"
        )
        return ""

    # Package mode: use sync functions via thread
    try:
        import asyncio

        from chat_shell.history.loader import get_knowledge_base_meta_prompt

        # Run sync function in thread pool
        return await asyncio.to_thread(get_knowledge_base_meta_prompt, db, task_id)
    except Exception as e:
        logger.warning(f"Failed to get KB meta prompt for task {task_id}: {e}")
        return ""


async def get_knowledge_base_meta_list(
    db: AsyncSession,
    task_id: int,
) -> List[dict]:
    """
    Get list of knowledge base meta information for a task.

    Args:
        db: Async database session
        task_id: Task ID

    Returns:
        List of dicts with kb_name and kb_id
    """
    from chat_shell.core.config import settings

    # In HTTP mode, skip KB meta list loading since it requires backend's app module
    mode = settings.CHAT_SHELL_MODE.lower()
    storage = settings.STORAGE_TYPE.lower()
    if mode == "http" and storage == "remote":
        logger.debug(
            f"[knowledge_factory] Skipping KB meta list in HTTP mode for task {task_id}"
        )
        return []

    # Package mode: use sync functions via thread
    try:
        import asyncio

        from chat_shell.history.loader import get_knowledge_base_meta_for_task

        # Run sync function in thread pool
        return await asyncio.to_thread(get_knowledge_base_meta_for_task, db, task_id)
    except Exception as e:
        logger.warning(f"Failed to get KB meta list for task {task_id}: {e}")
        return []
