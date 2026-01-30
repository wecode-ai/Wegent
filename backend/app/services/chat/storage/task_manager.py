# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task manager for Chat Shell.

This module provides utilities for creating and managing tasks and subtasks
for the chat functionality.
"""

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import SenderType, Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Bot, Task, Team

logger = logging.getLogger(__name__)


@dataclass
class TaskCreationResult:
    """Result of task and subtask creation."""

    task: TaskResource
    user_subtask: Subtask
    assistant_subtask: Optional[Subtask]
    ai_triggered: bool
    rag_prompt: Optional[str] = None


@dataclass
class TaskCreationParams:
    """Parameters for task creation."""

    message: str
    title: Optional[str] = None
    model_id: Optional[str] = None
    force_override_bot_model: bool = False
    force_override_bot_model_type: Optional[str] = (
        None  # Model type: 'public', 'user', 'group'
    )
    is_group_chat: bool = False
    git_url: Optional[str] = None
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    git_domain: Optional[str] = None
    branch_name: Optional[str] = None
    task_type: Optional[str] = None  # 'chat', 'code', or 'knowledge'
    knowledge_base_id: Optional[int] = (
        None  # Knowledge base ID for knowledge type tasks
    )


def get_bot_ids_from_team(db: Session, team: Kind) -> List[int]:
    """
    Get bot IDs from team members.

    Args:
        db: Database session
        team: Team Kind object

    Returns:
        List of bot IDs

    Raises:
        HTTPException: If no valid bots found in team
    """
    team_crd = Team.model_validate(team.json)
    bot_ids = []

    for member in team_crd.spec.members:
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active,
            )
            .first()
        )
        if bot:
            bot_ids.append(bot.id)

    if not bot_ids:
        raise HTTPException(status_code=400, detail="No valid bots found in team")

    return bot_ids


def get_task_with_access_check(
    db: Session, task_id: int, user_id: int
) -> tuple[Optional[TaskResource], int]:
    """
    Get task with access check, supporting both ownership and group membership.

    Args:
        db: Database session
        task_id: Task ID to retrieve
        user_id: User ID requesting access

    Returns:
        Tuple of (task, subtask_user_id) where subtask_user_id is the user_id
        to use for creating subtasks (owner's ID for group chats).
        Returns (None, user_id) if task not found or access denied.
    """
    from app.models.task_member import MemberStatus, TaskMember

    # First try to get task as owner
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.user_id == user_id,
            TaskResource.kind == "Task",
            TaskResource.is_active,
        )
        .first()
    )

    if task:
        return task, user_id

    # Check if user is a group chat member
    member = (
        db.query(TaskMember)
        .filter(
            TaskMember.task_id == task_id,
            TaskMember.user_id == user_id,
            TaskMember.status == MemberStatus.ACTIVE,
        )
        .first()
    )

    if member:
        # User is a group member, get task without user_id check
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active,
            )
            .first()
        )
        if task:
            # For group members, use task owner's user_id for subtasks
            return task, task.user_id

    # Task not found or access denied - log error and return None
    logger.error(
        "[get_task_with_access_check] Task not found or access denied: task_id=%d, user_id=%d",
        task_id,
        user_id,
    )
    return None, user_id


def check_task_status(db: Session, task: TaskResource) -> None:
    """
    Check if task is in a valid state for new messages.

    Args:
        db: Database session
        task: Task resource to check

    Raises:
        HTTPException: If task is still running
    """
    task_crd = Task.model_validate(task.json)
    if task_crd.status and task_crd.status.status == "RUNNING":
        raise HTTPException(status_code=400, detail="Task is still running")


def create_new_task(
    db: Session,
    user: User,
    team: Kind,
    params: TaskCreationParams,
) -> TaskResource:
    """
    Create a new task with workspace.

    Args:
        db: Database session
        user: User creating the task
        team: Team Kind object
        params: Task creation parameters

    Returns:
        Created TaskResource
    """
    from app.services.adapters.task_kinds import task_kinds_service

    # Create task ID first
    new_task_id = task_kinds_service.create_task_id(db, user.id)

    # Validate task ID
    if not task_kinds_service.validate_task_id(db, new_task_id):
        raise HTTPException(status_code=500, detail="Failed to create task ID")

    # Create workspace
    workspace_name = f"workspace-{new_task_id}"
    workspace_json = {
        "kind": "Workspace",
        "spec": {
            "repository": {
                "gitUrl": params.git_url or "",
                "gitRepo": params.git_repo or "",
                "gitRepoId": params.git_repo_id or 0,
                "gitDomain": params.git_domain or "",
                "branchName": params.branch_name or "",
            }
        },
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
    # Use custom title if provided, otherwise generate from message
    if params.title:
        title = params.title
    else:
        title = (
            params.message[:50] + "..." if len(params.message) > 50 else params.message
        )

    # Use provided task_type, or auto-detect based on git_url presence
    task_type = params.task_type
    if not task_type:
        task_type = "code" if params.git_url else "chat"

    logger.info(
        f"[create_new_task] Creating task_json with is_group_chat={params.is_group_chat}"
    )

    # Build knowledgeBaseRefs if knowledge_base_id is provided
    knowledge_base_refs = None
    if params.knowledge_base_id and task_type == "knowledge":
        # Query the knowledge base to get its name and namespace
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == params.knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )
        if kb:
            knowledge_base_refs = [
                {
                    "id": kb.id,
                    "name": kb.name,
                    "namespace": kb.namespace,
                    "boundBy": user.user_name,
                    "boundAt": datetime.now().isoformat(),
                }
            ]
            logger.info(
                f"[create_new_task] Added knowledgeBaseRefs for kb_id={kb.id}, name={kb.name}"
            )

    task_json = {
        "kind": "Task",
        "spec": {
            "title": title,
            "prompt": params.message,
            "teamRef": {"name": team.name, "namespace": team.namespace},
            "workspaceRef": {"name": workspace_name, "namespace": "default"},
            "is_group_chat": params.is_group_chat,
            **(
                {"knowledgeBaseRefs": knowledge_base_refs}
                if knowledge_base_refs
                else {}
            ),
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
                "taskType": task_type,
                "autoDeleteExecutor": "false",
                "source": "chat_shell",
                **({"modelId": params.model_id} if params.model_id else {}),
                **(
                    {"forceOverrideBotModel": "true"}
                    if params.force_override_bot_model
                    else {}
                ),
                **(
                    {"forceOverrideBotModelType": params.force_override_bot_model_type}
                    if params.force_override_bot_model_type
                    else {}
                ),
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

    logger.info(
        f"[create_new_task] Created task {new_task_id} with task_json.spec.is_group_chat="
        f"{task_json.get('spec', {}).get('is_group_chat', 'NOT_SET')}"
    )

    return task


def create_user_subtask(
    db: Session,
    subtask_user_id: int,
    sender_user_id: int,
    task_id: int,
    team_id: int,
    bot_ids: List[int],
    message: str,
    next_message_id: int,
    parent_id: int,
) -> Subtask:
    """
    Create a USER subtask for the chat message.

    Args:
        db: Database session
        subtask_user_id: User ID for subtask ownership (task owner for group chats)
        sender_user_id: Actual sender's user ID
        task_id: Task ID
        team_id: Team ID
        bot_ids: List of bot IDs
        message: User message content
        next_message_id: Message ID for this subtask
        parent_id: Parent message ID

    Returns:
        Created Subtask
    """
    user_subtask = Subtask(
        user_id=subtask_user_id,
        task_id=task_id,
        team_id=team_id,
        title="User message",
        bot_ids=bot_ids,
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt=message,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=next_message_id,
        parent_id=parent_id,
        error_message="",
        completed_at=datetime.now(),
        result=None,
        sender_type=SenderType.USER,
        sender_user_id=sender_user_id,
    )
    db.add(user_subtask)
    return user_subtask


def create_assistant_subtask(
    db: Session,
    subtask_user_id: int,
    task_id: int,
    team_id: int,
    bot_ids: List[int],
    next_message_id: int,
    parent_id: int,
) -> Subtask:
    """
    Create an ASSISTANT subtask for the AI response.

    Args:
        db: Database session
        subtask_user_id: User ID for subtask ownership (task owner for group chats)
        task_id: Task ID
        team_id: Team ID
        bot_ids: List of bot IDs
        next_message_id: Message ID for this subtask
        parent_id: Parent message ID (user message ID)

    Returns:
        Created Subtask
    """
    # Note: completed_at is set to a placeholder value because the DB column doesn't allow NULL
    # It will be updated when the stream completes
    assistant_subtask = Subtask(
        user_id=subtask_user_id,
        task_id=task_id,
        team_id=team_id,
        title="Assistant response",
        bot_ids=bot_ids,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="",
        executor_name="",
        prompt="",
        status=SubtaskStatus.PENDING,
        progress=0,
        message_id=next_message_id,
        parent_id=parent_id,
        error_message="",
        result=None,
        completed_at=datetime.now(),  # Placeholder, will be updated when stream completes
        sender_type=SenderType.TEAM,
        sender_user_id=0,  # AI has no user_id, use 0 instead of None
    )
    db.add(assistant_subtask)
    return assistant_subtask


def get_next_message_id(
    db: Session, task_id: int, subtask_user_id: int
) -> tuple[int, int]:
    """
    Get the next message ID and parent ID for a new subtask.

    Args:
        db: Database session
        task_id: Task ID
        subtask_user_id: User ID for subtask lookup

    Returns:
        Tuple of (next_message_id, parent_id)
    """
    existing_subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == subtask_user_id)
        .order_by(Subtask.message_id.desc())
        .all()
    )

    next_message_id = 1
    parent_id = 0
    if existing_subtasks:
        next_message_id = existing_subtasks[0].message_id + 1
        parent_id = existing_subtasks[0].message_id

    return next_message_id, parent_id


def get_existing_subtasks(
    db: Session, task_id: int, subtask_user_id: int
) -> List[Subtask]:
    """
    Get existing subtasks for a task.

    Args:
        db: Database session
        task_id: Task ID
        subtask_user_id: User ID for subtask lookup

    Returns:
        List of existing subtasks ordered by message_id descending
    """
    return (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == subtask_user_id)
        .order_by(Subtask.message_id.desc())
        .all()
    )


def update_task_timestamp(db: Session, task: TaskResource) -> None:
    """
    Update task timestamp for group chat messages.

    Args:
        db: Database session
        task: Task resource to update
    """
    from sqlalchemy.orm.attributes import flag_modified

    task.updated_at = datetime.now()
    # Also update the JSON status.updatedAt for consistency
    task_crd = Task.model_validate(task.json)
    if task_crd.status:
        task_crd.status.updatedAt = datetime.now()
        task.json = task_crd.model_dump(mode="json")
        flag_modified(task, "json")


async def initialize_redis_chat_history(
    task_id: int, existing_subtasks: List[Subtask]
) -> None:
    """
    Initialize Redis chat history from existing subtasks if needed.

    This is crucial for shared tasks that were copied with historical messages.

    Args:
        task_id: Task ID
        existing_subtasks: List of existing subtasks
    """
    if not existing_subtasks:
        return

    from app.services.chat.storage import session_manager

    # Check if history exists in Redis
    redis_history = await session_manager.get_chat_history(task_id)

    # If Redis history is empty but we have subtasks, rebuild history from DB
    if not redis_history:
        logger.info(
            f"Initializing chat history from DB for task {task_id} with {len(existing_subtasks)} existing subtasks"
        )
        history_messages = []

        # Sort subtasks by message_id to ensure correct order
        sorted_subtasks = sorted(existing_subtasks, key=lambda s: s.message_id)

        for subtask in sorted_subtasks:
            # Only include completed subtasks with results
            if subtask.status == SubtaskStatus.COMPLETED:
                if subtask.role == SubtaskRole.USER:
                    # User message - use prompt field
                    if subtask.prompt:
                        history_messages.append(
                            {"role": "user", "content": subtask.prompt}
                        )
                elif subtask.role == SubtaskRole.ASSISTANT:
                    # Assistant message - use result.value field
                    if subtask.result and isinstance(subtask.result, dict):
                        content = subtask.result.get("value", "")
                        if content:
                            history_messages.append(
                                {"role": "assistant", "content": content}
                            )

        # Save to Redis if we found any history
        if history_messages:
            await session_manager.save_chat_history(task_id, history_messages)
            logger.info(
                f"Initialized {len(history_messages)} messages in Redis for task {task_id}"
            )


async def create_task_and_subtasks(
    db: Session,
    user: User,
    team: Kind,
    message: str,
    params: TaskCreationParams,
    task_id: Optional[int] = None,
    should_trigger_ai: bool = True,
    rag_prompt: Optional[str] = None,
) -> TaskCreationResult:
    """
    Create or get task and create subtasks for chat.

    For group chat members, subtasks are created with the task owner's user_id
    to ensure proper message history and visibility across all members.

    Args:
        db: Database session
        user: User creating the message
        team: Team Kind object
        message: Original user message (for storage in subtask.prompt)
        params: Task creation parameters
        task_id: Optional existing task ID
        should_trigger_ai: If True, create both USER and ASSISTANT subtasks.
                          If False, only create USER subtask (for group chat without @mention)
        rag_prompt: Optional RAG-enhanced prompt (for AI inference, not stored in subtask)

    Returns:
        TaskCreationResult with task and subtask information
    """
    from app.services.chat.trigger.group_chat import (
        is_task_group_chat,
        notify_group_members_task_updated,
    )

    # Get bot IDs from team members
    bot_ids = get_bot_ids_from_team(db, team)

    task = None
    # Track the user_id to use for subtasks (owner's ID for group chats)
    subtask_user_id = user.id

    if task_id:
        # Get existing task with access check
        task, subtask_user_id = get_task_with_access_check(db, task_id, user.id)
        if task:
            check_task_status(db, task)
            # Update modelId in existing task if provided
            if params.model_id:
                from sqlalchemy.orm.attributes import flag_modified

                task_crd = Task.model_validate(task.json)
                if not task_crd.metadata.labels:
                    task_crd.metadata.labels = {}
                task_crd.metadata.labels["modelId"] = params.model_id
                if params.force_override_bot_model:
                    task_crd.metadata.labels["forceOverrideBotModel"] = "true"
                task.json = task_crd.model_dump(mode="json")
                flag_modified(task, "json")
                logger.info(
                    f"[create_task_and_subtasks] Updated modelId to {params.model_id} for existing task {task_id}"
                )
        else:
            # Task not found, treat as new conversation
            logger.info(
                f"[create_task_and_subtasks] Task {task_id} not found, creating new task"
            )

    if not task:
        # Create new task
        task = create_new_task(db, user, team, params)
        task_id = task.id
    # Get existing subtasks to determine message_id
    existing_subtasks = get_existing_subtasks(db, task_id, subtask_user_id)

    next_message_id, parent_id = get_next_message_id(db, task_id, subtask_user_id)

    # Create USER subtask (always created)
    user_subtask = create_user_subtask(
        db=db,
        subtask_user_id=subtask_user_id,
        sender_user_id=user.id,
        task_id=task_id,
        team_id=team.id,
        bot_ids=bot_ids,
        message=message,
        next_message_id=next_message_id,
        parent_id=parent_id,
    )

    # Create ASSISTANT subtask only if AI should be triggered
    assistant_subtask = None
    if should_trigger_ai:
        assistant_subtask = create_assistant_subtask(
            db=db,
            subtask_user_id=subtask_user_id,
            task_id=task_id,
            team_id=team.id,
            bot_ids=bot_ids,
            next_message_id=next_message_id + 1,
            parent_id=next_message_id,
        )

    # Update task.updated_at for group chat messages (even without AI trigger)
    if is_task_group_chat(task, params.is_group_chat):
        update_task_timestamp(db, task)

    db.commit()
    db.refresh(task)
    db.refresh(user_subtask)
    if assistant_subtask:
        db.refresh(assistant_subtask)

    # Store user message in long-term memory (fire-and-forget)
    # WebSocket chat (web) respects user preference for memory
    # This runs in background and doesn't block the main flow
    import asyncio

    from app.core.config import settings
    from app.services.memory import (
        build_context_messages,
        get_memory_manager,
        is_memory_enabled_for_user,
    )

    # Check user preference first
    if not is_memory_enabled_for_user(user):
        logger.info(
            "[task_manager] Long-term memory disabled by user preference, skipping memory save: user_id=%d",
            user.id,
        )
    else:
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
                current_message=message,
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
                            "[create_task_and_subtasks] Memory storage task failed for user %d, task %d, subtask %d: %s",
                            user.id,
                            task.id,
                            user_subtask.id,
                            exc,
                            exc_info=exc,
                        )
                except asyncio.CancelledError:
                    logger.info(
                        "[create_task_and_subtasks] Memory storage task cancelled for user %d, task %d, subtask %d",
                        user.id,
                        task.id,
                        user_subtask.id,
                    )

            memory_save_task = asyncio.create_task(
                memory_manager.save_user_message_async(
                    user_id=str(user.id),
                    team_id=str(team.id),
                    task_id=str(task.id),
                    subtask_id=str(user_subtask.id),
                    messages=context_messages,
                    workspace_id=workspace_id,
                    project_id=str(task.project_id) if task.project_id else None,
                    is_group_chat=is_group_chat,
                )
            )
            memory_save_task.add_done_callback(_log_memory_task_exception)
            logger.info(
                "[create_task_and_subtasks] Started background task to store memory for user %d, task %d, subtask %d",
                user.id,
                task.id,
                user_subtask.id,
            )

    # Initialize Redis chat history from existing subtasks if needed
    if existing_subtasks:
        await initialize_redis_chat_history(task_id, existing_subtasks)

    # Notify all group chat members about the new message via WebSocket
    if is_task_group_chat(task, params.is_group_chat):
        await notify_group_members_task_updated(db, task, user.id)

    return TaskCreationResult(
        task=task,
        user_subtask=user_subtask,
        assistant_subtask=assistant_subtask,
        ai_triggered=should_trigger_ai,
        rag_prompt=rag_prompt,
    )


async def create_chat_task(
    db: Session,
    user: User,
    team: Kind,
    message: str,
    params: TaskCreationParams,
    task_id: Optional[int] = None,
    should_trigger_ai: bool = True,
    rag_prompt: Optional[str] = None,
    source: str = "web",
) -> TaskCreationResult:
    """
    Unified chat task creation entry point.

    Automatically determines whether to use Chat Shell or Executor path
    based on team configuration. This eliminates duplicate code between
    WebSocket chat:send and Flow task execution.

    Args:
        db: Database session
        user: User creating the message
        team: Team Kind object
        message: User message
        params: Task creation parameters
        task_id: Optional existing task ID
        should_trigger_ai: If True, create both USER and ASSISTANT subtasks
        rag_prompt: Optional RAG-enhanced prompt for AI inference
        source: Source of the task ("web", "flow", "api")

    Returns:
        TaskCreationResult with task and subtask information
    """
    from app.models.subtask import SubtaskRole
    from app.models.task import TaskResource
    from app.schemas.task import TaskCreate
    from app.services.adapters.task_kinds import task_kinds_service
    from app.services.chat.config import should_use_direct_chat

    # Log input parameters for debugging (DEBUG level to avoid log noise)
    logger.debug(
        f"[create_chat_task] Entry: team_id={team.id}, user_id={user.id}, "
        f"task_id={task_id}, source={source}, should_trigger_ai={should_trigger_ai}"
    )

    supports_direct_chat = should_use_direct_chat(db, team, user.id)
    logger.debug(f"[create_chat_task] supports_direct_chat={supports_direct_chat}")

    if supports_direct_chat:
        # Chat Shell path - use create_task_and_subtasks
        logger.debug("[create_chat_task] Using Chat Shell path")
        result = await create_task_and_subtasks(
            db=db,
            user=user,
            team=team,
            message=message,
            params=params,
            task_id=task_id,
            should_trigger_ai=should_trigger_ai,
            rag_prompt=rag_prompt,
        )
        logger.debug(
            f"[create_chat_task] Chat Shell result: task_id={result.task.id if result.task else None}"
        )
        return result
    else:
        # Executor path - use task_kinds_service.create_task_or_append
        logger.debug("[create_chat_task] Using Executor path")

        # Use provided task_type, or auto-detect based on git_url presence
        task_type = params.task_type
        if not task_type:
            task_type = "code" if params.git_url else "chat"

        # Build TaskCreate object
        task_create = TaskCreate(
            title=params.title,
            team_id=team.id,
            team_name=team.name,
            team_namespace=team.namespace,
            git_url=params.git_url or "",
            git_repo=params.git_repo or "",
            git_repo_id=params.git_repo_id or 0,
            git_domain=params.git_domain or "",
            branch_name=params.branch_name or "",
            prompt=message,
            type="online",
            task_type=task_type,
            auto_delete_executor="false",
            source=source,
            model_id=params.model_id,
            force_override_bot_model=params.force_override_bot_model,
            force_override_bot_model_type=params.force_override_bot_model_type,
        )

        # Call create_task_or_append (synchronous method)
        task_dict = task_kinds_service.create_task_or_append(
            db=db,
            obj_in=task_create,
            user=user,
            task_id=task_id,
        )

        created_task_id = task_dict["id"]

        # Get the task TaskResource object from database
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == created_task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        logger.debug(
            f"[create_chat_task] Executor task created: task_id={created_task_id}"
        )

        # Query the created subtasks from database
        # Get the latest USER subtask for this task
        user_subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == created_task_id,
                Subtask.role == SubtaskRole.USER,
            )
            .order_by(Subtask.id.desc())
            .first()
        )

        # Get the latest ASSISTANT subtask for this task (if should_trigger_ai)
        assistant_subtask = None
        if should_trigger_ai:
            assistant_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == created_task_id,
                    Subtask.role == SubtaskRole.ASSISTANT,
                )
                .order_by(Subtask.id.desc())
                .first()
            )

        logger.debug(
            f"[create_chat_task] Executor result: task_id={task.id if task else None}"
        )

        return TaskCreationResult(
            task=task,
            user_subtask=user_subtask,
            assistant_subtask=assistant_subtask,
            ai_triggered=should_trigger_ai,
            rag_prompt=rag_prompt,
        )
