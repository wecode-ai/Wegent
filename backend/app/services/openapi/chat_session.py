# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat session setup for OpenAPI v1/responses endpoint.
Contains ChatSessionSetup and related functions.
"""

import logging
from typing import Any, Dict, List, NamedTuple, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.chat.storage.task_manager import TaskCreationParams
from app.services.chat.trigger.lifecycle import prepare_execution_session

logger = logging.getLogger(__name__)


class ChatSessionSetup(NamedTuple):
    """Result of chat session setup."""

    task: TaskResource
    task_id: int
    user_subtask: Subtask  # User message subtask (for history exclusion)
    assistant_subtask: Subtask
    existing_subtasks: List[Subtask]
    bot_name: str  # First bot's name for MCP loading
    bot_namespace: str  # First bot's namespace for MCP loading


def setup_chat_session(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
) -> ChatSessionSetup:
    """
    Set up chat session: build config, create task and subtasks.

    Args:
        db: Database session
        user: Current user
        team: Team Kind object
        model_info: Parsed model info
        input_text: User input text
        tool_settings: Tool settings
        task_id: Optional existing task ID
        api_key_name: Optional API key name

    Returns:
        ChatSessionSetup with task, subtasks, and config
    """
    workspace_data = tool_settings.get("workspace") or {}
    task_params = TaskCreationParams(
        message=input_text,
        model_id=model_info.get("model_id"),
        force_override_bot_model=model_info.get("model_id") is not None,
        git_url=workspace_data.get("git_url"),
        git_repo=workspace_data.get("git_repo"),
        git_domain=workspace_data.get("git_domain"),
        branch_name=workspace_data.get("branch"),
        task_type="code" if workspace_data.get("git_url") else "chat",
        source="chat_shell",
        is_api_call=True,
        api_key_name=api_key_name,
    )

    session = prepare_execution_session(
        db=db,
        user=user,
        team=team,
        input_text=input_text,
        task_params=task_params,
        task_id=task_id,
        should_trigger_ai=True,
    )

    # Store user message in long-term memory (fire-and-forget)
    # Only store if enable_chat_bot=True (wegent_chat_bot tool is enabled)
    # This runs in background and doesn't block the main flow
    enable_chat_bot = tool_settings.get("enable_chat_bot", False)
    if enable_chat_bot:
        import asyncio

        from app.core.config import settings
        from app.services.memory import build_context_messages, get_memory_manager

        memory_manager = get_memory_manager()
        if memory_manager.is_enabled:
            task_crd = Task.model_validate(session.task.json)
            workspace_id = (
                f"{task_crd.spec.workspaceRef.namespace}/{task_crd.spec.workspaceRef.name}"
                if task_crd.spec.workspaceRef
                else None
            )
            is_group_chat = task_crd.spec.is_group_chat

            # Build context messages using shared utility
            context_messages = build_context_messages(
                db=db,
                existing_subtasks=session.existing_subtasks,
                current_message=input_text,
                current_user=user,
                is_group_chat=is_group_chat,
                context_limit=settings.MEMORY_CONTEXT_MESSAGES,
            )

            # Create task with proper exception handling
            def _log_memory_task_exception(task_obj: asyncio.Task) -> None:
                """Log exceptions from background memory storage task."""
                try:
                    exc = task_obj.exception()
                    if exc is not None:
                        logger.error(
                            "[setup_chat_session] Memory storage task failed for user %d, task %d, subtask %d: %s",
                            user.id,
                            session.task_id,
                            session.user_subtask.id,
                            exc,
                            exc_info=exc,
                        )
                except asyncio.CancelledError:
                    logger.info(
                        "[setup_chat_session] Memory storage task cancelled for user %d, task %d, subtask %d",
                        user.id,
                        session.task_id,
                        session.user_subtask.id,
                    )

            # Use get_running_loop with proper error handling
            try:
                loop = asyncio.get_running_loop()
                memory_save_task = loop.create_task(
                    memory_manager.save_user_message_async(
                        user_id=str(user.id),
                        team_id=str(team.id),
                        task_id=str(session.task_id),
                        subtask_id=str(session.user_subtask.id),
                        messages=context_messages,
                        workspace_id=workspace_id,
                        project_id=(
                            str(session.task.project_id)
                            if session.task.project_id
                            else None
                        ),
                        is_group_chat=is_group_chat,
                    )
                )
                memory_save_task.add_done_callback(_log_memory_task_exception)
                logger.info(
                    "[setup_chat_session] Started background task to store memory for user %d, task %d, subtask %d (enable_chat_bot=True)",
                    user.id,
                    session.task_id,
                    session.user_subtask.id,
                )
            except RuntimeError:
                # No event loop is running - this is unexpected in FastAPI context
                logger.warning(
                    "[setup_chat_session] Cannot create background task: no event loop running"
                )

    return ChatSessionSetup(
        task=session.task,
        task_id=session.task_id,
        user_subtask=session.user_subtask,
        assistant_subtask=session.assistant_subtask,
        existing_subtasks=session.existing_subtasks,
        bot_name=session.bot_name,
        bot_namespace=session.bot_namespace,
    )
