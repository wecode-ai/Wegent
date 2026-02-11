# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base tools factory module.

Responsible for creating knowledge base search tools and enhancing system prompts.
"""

import logging
from typing import Any, List, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_async

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
    model_id: Optional[str] = None,
    context_window: Optional[int] = None,
    skip_prompt_enhancement: bool = False,
    user_name: Optional[str] = None,
) -> tuple[list, str]:
    """
    Prepare knowledge base tools and enhanced system prompt.

    This function encapsulates the logic for creating KnowledgeBaseTool,
    KbLsTool, KbHeadTool and enhancing the system prompt with knowledge base instructions.

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
        model_id: Optional model_id used by the current chat model.
            Used by KnowledgeBaseTool for token counting and injection decisions.
        context_window: Optional context window size from Model CRD.
            Used by KnowledgeBaseTool for injection strategy decisions.
        skip_prompt_enhancement: If True, skip adding KB prompt instructions to system prompt.
            Used in HTTP mode when Backend has already added KB prompts to avoid duplication.
        user_name: Optional user name for embedding API custom headers (placeholder replacement).

    Returns:
        Tuple of (extra_tools list, enhanced_system_prompt string)
    """
    extra_tools = []
    enhanced_system_prompt = base_system_prompt

    if not knowledge_base_ids:
        # Even without current knowledge bases, check for historical KB meta
        # Skip if in HTTP mode with prompt enhancement already done by Backend
        if task_id and not skip_prompt_enhancement:
            kb_meta_prompt = await _build_historical_kb_meta_prompt(db, task_id)
            if kb_meta_prompt:
                enhanced_system_prompt = f"{base_system_prompt}{kb_meta_prompt}"
        return extra_tools, enhanced_system_prompt

    logger.info(
        "[knowledge_factory] Creating KB tools for %d knowledge bases: %s, "
        "is_user_selected=%s, document_ids=%s, model_id=%s, context_window=%s",
        len(knowledge_base_ids),
        knowledge_base_ids,
        is_user_selected,
        document_ids,
        model_id,
        context_window,
    )

    # Import knowledge base tools
    from chat_shell.tools.builtin import (
        KbHeadTool,
        KbLsTool,
        KBToolCallCounter,
        KnowledgeBaseTool,
    )

    # Create KnowledgeBaseTool with the specified knowledge bases
    # KB configs (max_calls, exempt_calls, name) are fetched from Backend API
    # Pass user_subtask_id for persisting RAG results to context database
    # Pass document_ids for filtering to specific documents
    # Pass context_window from Model CRD for injection strategy decisions
    kb_tool = KnowledgeBaseTool(
        knowledge_base_ids=knowledge_base_ids,
        document_ids=document_ids or [],
        user_id=user_id,
        user_name=user_name,
        db_session=db,
        user_subtask_id=user_subtask_id,
        model_id=model_id or KnowledgeBaseTool.model_id,
        context_window=context_window,
    )
    extra_tools.append(kb_tool)

    # Create shared call counter for exploration tools (kb_ls and kb_head)
    # These tools share the same max_calls_per_conversation limit as knowledge_base_search
    # Get the actual limit from kb_tool configuration to ensure consistency
    try:
        max_calls, _ = kb_tool._get_kb_limits()
    except Exception:
        # KnowledgeBaseTool may be mocked in unit tests; fall back to defaults.
        max_calls = 10
    exploration_call_counter = KBToolCallCounter(max_calls=max_calls)

    # Create exploration tools (kb_ls and kb_head)
    # These are secondary tools for when RAG search doesn't find relevant results
    # They share a call counter to enforce combined call limits
    kb_ls_tool = KbLsTool(
        knowledge_base_ids=knowledge_base_ids,
        db_session=db,
    )
    kb_ls_tool._call_counter = exploration_call_counter

    kb_head_tool = KbHeadTool(
        knowledge_base_ids=knowledge_base_ids,
        user_id=user_id,
        db_session=db,
        user_subtask_id=user_subtask_id,
    )
    kb_head_tool._call_counter = exploration_call_counter

    extra_tools.extend([kb_ls_tool, kb_head_tool])

    logger.info(
        "[knowledge_factory] Created 3 KB tools: knowledge_base_search, kb_ls, kb_head"
    )

    # Skip prompt enhancement if Backend has already added KB prompts (HTTP mode)
    if skip_prompt_enhancement:
        logger.info(
            "[knowledge_factory] Skipping KB prompt enhancement (already done by Backend)"
        )
        return extra_tools, enhanced_system_prompt

    # Import shared prompt constants from chat_shell prompts module
    from chat_shell.prompts import KB_PROMPT_NO_RAG, KB_PROMPT_RELAXED, KB_PROMPT_STRICT

    # Check if any KB has RAG enabled by querying KB info
    has_rag_enabled = await _check_any_kb_has_rag_enabled(knowledge_base_ids)

    # Choose prompt based on RAG availability and user selection mode
    if not has_rag_enabled:
        # No-RAG mode: Use exploration tools only
        kb_instruction = KB_PROMPT_NO_RAG
        logger.info(
            "[knowledge_factory] Using NO_RAG mode prompt (no retriever configured)"
        )
    elif is_user_selected:
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

    # Get historical knowledge base meta info if available
    kb_meta_prompt = ""
    if task_id:
        kb_meta_prompt = await _build_historical_kb_meta_prompt(db, task_id)

    # Inject KB meta list into the template using format method
    # This ensures the KB list appears inside the <knowledge_base> tag
    kb_instruction_with_meta = kb_instruction.format(kb_meta_list=kb_meta_prompt)
    enhanced_system_prompt = f"{base_system_prompt}{kb_instruction_with_meta}"

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


@trace_async(
    span_name="check_any_kb_has_rag_enabled",
    tracer_name="chat_shell.tools.knowledge_factory",
)
async def _check_any_kb_has_rag_enabled(knowledge_base_ids: list[int]) -> bool:
    """
    Check if any of the given knowledge bases have RAG enabled.

    This function queries the Backend API to get KB info and checks if any KB
    has a retriever configured (rag_enabled=True).

    Args:
        knowledge_base_ids: List of knowledge base IDs to check

    Returns:
        True if at least one KB has RAG enabled, False otherwise
    """
    set_span_attribute("knowledge_base_ids.count", len(knowledge_base_ids))

    if not knowledge_base_ids:
        add_span_event("no_knowledge_bases")
        return False

    from chat_shell.core.config import settings

    try:
        import httpx

        add_span_event("querying_backend_api")

        # Query KB info from Backend API
        url = f"{settings.BACKEND_URL}/api/internal/rag/kb-size"
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                url,
                json={"knowledge_base_ids": knowledge_base_ids},
            )
            response.raise_for_status()
            data = response.json()

            # Check if any KB has rag_enabled=True
            items = data.get("items", [])
            for item in items:
                if item.get("rag_enabled", False):
                    logger.debug(
                        f"[knowledge_factory] KB {item.get('id')} has RAG enabled"
                    )
                    add_span_event("rag_enabled_found")
                    set_span_attribute("rag_enabled", True)
                    set_span_attribute("kb_id_with_rag", item.get("id"))
                    return True

            logger.info(
                f"[knowledge_factory] No KB has RAG enabled among {knowledge_base_ids}"
            )
            add_span_event("no_rag_enabled")
            set_span_attribute("rag_enabled", False)
            return False

    except Exception as e:
        logger.warning(
            f"[knowledge_factory] Failed to check RAG status for KBs {knowledge_base_ids}: {e}. "
            "Assuming RAG is enabled (fallback to normal behavior)."
        )
        add_span_event("check_failed")
        set_span_attribute("error", str(e))
        set_span_attribute("rag_enabled", True)  # fallback
        # On error, assume RAG is enabled to avoid breaking existing functionality
        return True
