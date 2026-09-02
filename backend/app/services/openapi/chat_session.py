# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat session setup for OpenAPI v1/responses endpoint.
Contains ChatSessionSetup and related functions.
"""

from typing import Any, Dict, List, NamedTuple, Optional

from sqlalchemy.orm import Session

from app.core.web_background_tasks import web_background_task_manager
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.chat.storage.task_manager import TaskCreationParams
from app.services.chat.trigger.lifecycle import prepare_execution_session


class ChatSessionSetup(NamedTuple):
    """Result of chat session setup."""

    task: TaskResource
    task_id: int
    user_subtask: Subtask  # User message subtask (for history exclusion)
    assistant_subtask: Subtask
    existing_subtasks: List[Subtask]
    bot_name: str  # First bot's name for MCP loading
    bot_namespace: str  # First bot's namespace for MCP loading
    memory_save_request: Optional[Dict[str, Any]] = None


def schedule_memory_save(memory_save_request: Optional[Dict[str, Any]]) -> None:
    """Schedule a prepared long-term-memory write on the active event loop."""
    if not memory_save_request:
        return

    from app.services.memory import get_memory_manager

    memory_manager = get_memory_manager()
    if not memory_manager.is_enabled:
        return
    subtask_id = memory_save_request.get("subtask_id", "unknown")
    web_background_task_manager.submit_nowait(
        lambda: memory_manager.save_user_message_async(**memory_save_request),
        name=f"openapi-memory-save-{subtask_id}",
    )


def setup_chat_session(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
    api_key_name: Optional[str] = None,
    auto_delete_executor: Optional[str] = None,
    generation_params: Optional[Dict[str, Any]] = None,
    defer_memory_save: bool = False,
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
    model_type = str(model_info.get("model_type") or "").strip().lower()
    task_type = (
        model_type
        if model_type in {"image", "video"}
        else "code" if workspace_data.get("git_url") else "chat"
    )
    task_params = TaskCreationParams(
        message=input_text,
        model_id=model_info.get("model_id"),
        force_override_bot_model=model_info.get("model_id") is not None,
        git_url=workspace_data.get("git_url"),
        git_repo=workspace_data.get("git_repo"),
        git_domain=workspace_data.get("git_domain"),
        branch_name=workspace_data.get("branch"),
        task_type=task_type,
        source="chat_shell",
        is_api_call=True,
        api_key_name=api_key_name,
        auto_delete_executor=auto_delete_executor,
        generate_params=generation_params,
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
    memory_save_request = None
    enable_chat_bot = tool_settings.get("enable_chat_bot", False)
    if enable_chat_bot:
        from app.core.config import settings
        from app.services.memory import build_context_messages

        if settings.MEMORY_ENABLED:
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

            memory_save_request = {
                "user_id": str(user.id),
                "team_id": str(team.id),
                "task_id": str(session.task_id),
                "subtask_id": str(session.user_subtask.id),
                "messages": context_messages,
                "workspace_id": workspace_id,
                "project_id": (
                    str(session.task.project_id) if session.task.project_id else None
                ),
                "is_group_chat": is_group_chat,
            }
            if not defer_memory_save:
                schedule_memory_save(memory_save_request)
                memory_save_request = None

    return ChatSessionSetup(
        task=session.task,
        task_id=session.task_id,
        user_subtask=session.user_subtask,
        assistant_subtask=session.assistant_subtask,
        existing_subtasks=session.existing_subtasks,
        bot_name=session.bot_name,
        bot_namespace=session.bot_namespace,
        memory_save_request=memory_save_request,
    )
