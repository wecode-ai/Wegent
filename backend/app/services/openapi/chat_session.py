# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat session setup for OpenAPI v1/responses endpoint.
Contains ChatSessionSetup and related functions.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, NamedTuple, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import SenderType, Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task, Team
from app.services.adapters.task_kinds import task_kinds_service
from app.services.readers.kinds import KindType, kindReader

logger = logging.getLogger(__name__)


class ChatSessionSetup(NamedTuple):
    """Result of chat session setup."""

    task: TaskResource
    task_id: int
    user_subtask: Subtask  # User message subtask (for history exclusion)
    assistant_subtask: Subtask
    existing_subtasks: List[Subtask]
    model_config: Any
    system_prompt: str
    bot_name: str  # First bot's name for MCP loading
    bot_namespace: str  # First bot's namespace for MCP loading
    preload_skills: List[str]  # Preload skills from ChatConfig
    skill_names: List[str]  # Available skill names from ChatConfig
    skill_configs: List[Dict[str, Any]]  # Full skill configurations from ChatConfig


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
    from app.services.chat.config import ChatConfigBuilder

    # Build chat configuration
    config_builder = ChatConfigBuilder(
        db=db,
        team=team,
        user_id=user.id,
        user_name=user.user_name,
    )

    enable_deep_thinking = tool_settings.get("enable_deep_thinking", False)
    preload_skills = tool_settings.get("preload_skills", [])
    try:
        chat_config = config_builder.build(
            override_model_name=model_info.get("model_id"),
            force_override=model_info.get("model_id") is not None,
            enable_clarification=False,
            enable_deep_thinking=enable_deep_thinking,
            task_id=task_id or 0,
            preload_skills=preload_skills,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    model_config = chat_config.model_config
    system_prompt = chat_config.system_prompt

    # Get bot IDs from team members
    team_crd = Team.model_validate(team.json)
    if not team_crd.spec.members:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Team has no members configured",
        )

    bot_ids = []
    first_bot_name = ""
    first_bot_namespace = "default"
    for member in team_crd.spec.members:
        member_bot = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.BOT,
            member.botRef.namespace,
            member.botRef.name,
        )
        if member_bot:
            bot_ids.append(member_bot.id)
            # Capture first bot info for MCP loading
            if not first_bot_name:
                first_bot_name = member.botRef.name
                first_bot_namespace = member.botRef.namespace

    if not bot_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid bots found in team",
        )

    # Create or get task
    task = None
    if task_id:
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )
        if not task:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Task {task_id} not found",
            )

    if not task:
        new_task_id = task_kinds_service.create_task_id(db, user.id)

        if not task_kinds_service.validate_task_id(db, new_task_id):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create task ID",
            )

        # Create workspace
        workspace_name = f"workspace-{new_task_id}"
        workspace_json = {
            "kind": "Workspace",
            "spec": {"repository": {}},
            "status": {"state": "Available"},
            "metadata": {"name": workspace_name, "namespace": "default"},
            "apiVersion": "agent.wecode.io/v1",
        }

        workspace = TaskResource(
            user_id=user.id,
            kind="Workspace",
            name=workspace_name,
            namespace="default",
            json=workspace_json,
            is_active=True,
        )
        db.add(workspace)

        # Create task
        title = input_text[:50] + "..." if len(input_text) > 50 else input_text
        task_json = {
            "kind": "Task",
            "spec": {
                "title": title,
                "prompt": input_text,
                "teamRef": {"name": team.name, "namespace": team.namespace},
                "workspaceRef": {"name": workspace_name, "namespace": "default"},
                "is_group_chat": False,
            },
            "status": {
                "state": "Available",
                "status": "PENDING",
                "progress": 0,
                "result": None,
                "errorMessage": "",
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
                "completedAt": None,
            },
            "metadata": {
                "name": f"task-{new_task_id}",
                "namespace": "default",
                "labels": {
                    "type": "online",
                    "taskType": "chat",
                    "autoDeleteExecutor": "false",
                    "source": "chat_shell",
                    "is_api_call": "true",
                    **(
                        {"modelId": model_info.get("model_id")}
                        if model_info.get("model_id")
                        else {}
                    ),
                    **(
                        {"forceOverrideBotModel": "true"}
                        if model_info.get("model_id")
                        else {}
                    ),
                    **({"api_key_name": api_key_name} if api_key_name else {}),
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        }

        task = TaskResource(
            id=new_task_id,
            user_id=user.id,
            kind="Task",
            name=f"task-{new_task_id}",
            namespace="default",
            json=task_json,
            is_active=True,
        )
        db.add(task)
        task_id = new_task_id

    # Get existing subtasks
    existing_subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == user.id)
        .order_by(Subtask.message_id.desc())
        .all()
    )

    next_message_id = 1
    parent_id = 0
    if existing_subtasks:
        next_message_id = existing_subtasks[0].message_id + 1
        parent_id = existing_subtasks[0].message_id

    # Create USER subtask
    user_subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team.id,
        title="User message",
        bot_ids=bot_ids,
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt=input_text,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=next_message_id,
        parent_id=parent_id,
        error_message="",
        completed_at=datetime.now(),
        result=None,
        sender_type=SenderType.USER,
        sender_user_id=user.id,
    )
    db.add(user_subtask)

    # Create ASSISTANT subtask
    assistant_subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team.id,
        title="Assistant response",
        bot_ids=bot_ids,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="",
        executor_name="",
        prompt="",
        status=SubtaskStatus.PENDING,
        progress=0,
        message_id=next_message_id + 1,
        parent_id=next_message_id,
        error_message="",
        result=None,
        completed_at=datetime.now(),
        sender_type=SenderType.TEAM,
        sender_user_id=0,
    )
    db.add(assistant_subtask)

    db.commit()
    db.refresh(task)
    db.refresh(user_subtask)
    db.refresh(assistant_subtask)

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
            task_crd = Task.model_validate(task.json)
            workspace_id = (
                f"{task_crd.spec.workspaceRef.namespace}/{task_crd.spec.workspaceRef.name}"
                if task_crd.spec.workspaceRef
                else None
            )
            is_group_chat = task_crd.spec.is_group_chat

            # Build context messages using shared utility
            context_messages = build_context_messages(
                db=db,
                existing_subtasks=existing_subtasks,
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
                            task_id,
                            user_subtask.id,
                            exc,
                            exc_info=exc,
                        )
                except asyncio.CancelledError:
                    logger.info(
                        "[setup_chat_session] Memory storage task cancelled for user %d, task %d, subtask %d",
                        user.id,
                        task_id,
                        user_subtask.id,
                    )

            # Use get_running_loop with proper error handling
            try:
                loop = asyncio.get_running_loop()
                memory_save_task = loop.create_task(
                    memory_manager.save_user_message_async(
                        user_id=str(user.id),
                        team_id=str(team.id),
                        task_id=str(task_id),
                        subtask_id=str(user_subtask.id),
                        messages=context_messages,
                        workspace_id=workspace_id,
                        project_id=str(task.project_id) if task.project_id else None,
                        is_group_chat=is_group_chat,
                    )
                )
                memory_save_task.add_done_callback(_log_memory_task_exception)
                logger.info(
                    "[setup_chat_session] Started background task to store memory for user %d, task %d, subtask %d (enable_chat_bot=True)",
                    user.id,
                    task_id,
                    user_subtask.id,
                )
            except RuntimeError:
                # No event loop is running - this is unexpected in FastAPI context
                logger.warning(
                    "[setup_chat_session] Cannot create background task: no event loop running"
                )

    return ChatSessionSetup(
        task=task,
        task_id=task_id,
        user_subtask=user_subtask,
        assistant_subtask=assistant_subtask,
        existing_subtasks=existing_subtasks,
        model_config=model_config,
        system_prompt=system_prompt,
        bot_name=first_bot_name,
        bot_namespace=first_bot_namespace,
        preload_skills=chat_config.preload_skills,
        skill_names=chat_config.skill_names,
        skill_configs=chat_config.skill_configs,
    )


def build_chat_history(existing_subtasks: List[Subtask]) -> List[Dict[str, str]]:
    """Build chat history from existing subtasks."""
    history = []
    sorted_subtasks = sorted(existing_subtasks, key=lambda s: s.message_id)
    for st in sorted_subtasks:
        if st.status == SubtaskStatus.COMPLETED:
            if st.role == SubtaskRole.USER and st.prompt:
                history.append({"role": "user", "content": st.prompt})
            elif st.role == SubtaskRole.ASSISTANT and st.result:
                if isinstance(st.result, dict):
                    content = st.result.get("value", "")
                    if content:
                        history.append({"role": "assistant", "content": content})
    return history
