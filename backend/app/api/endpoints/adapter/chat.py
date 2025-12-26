# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell API endpoints.

Provides streaming chat API for Chat Shell type, bypassing Docker Executor.
"""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.subtask import SenderType, Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.kind import Bot, Shell, Task, Team
from app.services.chat.base import ChatServiceBase
from app.services.chat.chat_service import chat_service
from app.services.chat.model_resolver import (
    build_default_headers_with_placeholders,
    get_bot_system_prompt,
    get_model_config_for_bot,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class StreamChatRequest(BaseModel):
    """Request body for streaming chat."""

    message: str
    team_id: int
    task_id: Optional[int] = None  # Optional for multi-turn conversations
    title: Optional[str] = None  # Optional custom title for new tasks
    model_id: Optional[str] = None  # Optional model override
    force_override_bot_model: bool = False
    attachment_id: Optional[int] = None  # Optional attachment ID for file upload
    # Web search toggle
    enable_web_search: bool = False  # Enable web search for this message
    search_engine: Optional[str] = None  # Search engine to use
    # Clarification mode toggle
    enable_clarification: bool = False  # Enable clarification mode for this message
    # Git info (optional, for record keeping)
    git_url: Optional[str] = None
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    git_domain: Optional[str] = None
    branch_name: Optional[str] = None
    # Resume/reconnect parameters for offset-based streaming
    subtask_id: Optional[int] = None  # For resuming an existing stream
    offset: Optional[int] = None  # Character offset for resuming (0 = new stream)
    # Group chat flag
    is_group_chat: bool = False  # Whether this is a group chat


def _get_shell_type(db: Session, bot: Kind, user_id: int) -> str:
    """Get shell type for a bot."""
    bot_crd = Bot.model_validate(bot.json)

    # First check user's custom shells
    shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == bot_crd.spec.shellRef.name,
            Kind.namespace == bot_crd.spec.shellRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    # If not found, check public shells
    if not shell:
        public_shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Shell",
                Kind.name == bot_crd.spec.shellRef.name,
                Kind.namespace == bot_crd.spec.shellRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if public_shell and public_shell.json:
            shell_crd = Shell.model_validate(public_shell.json)
            return shell_crd.spec.shellType
        return ""

    if shell and shell.json:
        shell_crd = Shell.model_validate(shell.json)
        return shell_crd.spec.shellType

    return ""


def _should_use_direct_chat(db: Session, team: Kind, user_id: int) -> bool:
    """
    Check if the team should use direct chat mode.

    Returns True only if ALL bots in the team use Chat Shell type.
    """
    team_crd = Team.model_validate(team.json)

    for member in team_crd.spec.members:
        # Find bot
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            return False

        shell_type = _get_shell_type(db, bot, team.user_id)
        is_direct_chat = ChatServiceBase.is_direct_chat_shell(shell_type)

        if not is_direct_chat:
            return False

    return True


def _should_trigger_ai_response(
    task_json: dict, prompt: str, team_name: str, request_is_group_chat: bool = False
) -> bool:
    """
    Determine whether to trigger AI response based on task mode and prompt content.

    For non-group-chat mode: always trigger AI
    For group-chat mode: only trigger if prompt contains @TeamName (exact match)

    Args:
        task_json: Task's JSON spec
        prompt: User's input message
        team_name: Associated Team name
        request_is_group_chat: Whether the request explicitly marks this as a group chat
                              (used for new tasks where task_json is empty)

    Returns:
        True if AI response should be triggered, False if only save message
    """
    # Check if task is in group chat mode
    # For existing tasks: check task_json.spec.is_group_chat
    # For new tasks: use request_is_group_chat parameter
    is_group_chat = task_json.get("spec", {}).get("is_group_chat", False)

    # If task_json doesn't have is_group_chat set, use the request parameter
    # This handles the case of creating a new group chat task
    if not is_group_chat and request_is_group_chat:
        is_group_chat = True

    # Non-group-chat mode: always trigger AI
    if not is_group_chat:
        return True

    # Group chat mode: check for @TeamName mention (exact match)
    mention_pattern = f"@{team_name}"
    return mention_pattern in prompt


async def _create_task_and_subtasks(
    db: Session,
    user: User,
    team: Kind,
    message: str,
    request: StreamChatRequest,
    task_id: Optional[int] = None,
    should_trigger_ai: bool = True,
    rag_prompt: Optional[str] = None,
) -> dict:
    """
    Create or get task and create subtasks for chat.

    For group chat members, subtasks are created with the task owner's user_id
    to ensure proper message history and visibility across all members.

    Args:
        message: Original user message (for storage in subtask.prompt)
        request: Stream chat request
        task_id: Optional existing task ID
        should_trigger_ai: If True, create both USER and ASSISTANT subtasks.
                          If False, only create USER subtask (for group chat without @mention)
        rag_prompt: Optional RAG-enhanced prompt (for AI inference, not stored in subtask)

    Returns:
        Dict with keys:
        - task: Task Kind object
        - user_subtask: User subtask (always created)
        - assistant_subtask: Assistant subtask (only if should_trigger_ai=True)
        - ai_triggered: Whether AI was triggered
        - rag_prompt: RAG prompt to use for AI (if provided)
    """
    team_crd = Team.model_validate(team.json)

    # Get bot IDs from team members
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

    task = None
    # Track the user_id to use for subtasks (owner's ID for group chats)
    subtask_user_id = user.id

    if task_id:
        # Get existing task - check both ownership and membership
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.user_id == user.id,
                Kind.kind == "Task",
                Kind.is_active,
            )
            .first()
        )

        # If not found as owner, check if user is a group chat member
        if not task:
            from app.models.task_member import MemberStatus, TaskMember

            member = (
                db.query(TaskMember)
                .filter(
                    TaskMember.task_id == task_id,
                    TaskMember.user_id == user.id,
                    TaskMember.status == MemberStatus.ACTIVE,
                )
                .first()
            )

            if member:
                # User is a group member, get task without user_id check
                task = (
                    db.query(Kind)
                    .filter(
                        Kind.id == task_id,
                        Kind.kind == "Task",
                        Kind.is_active,
                    )
                    .first()
                )
                # For group members, use task owner's user_id for subtasks
                if task:
                    subtask_user_id = task.user_id

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Check task status
        task_crd = Task.model_validate(task.json)
        if task_crd.status and task_crd.status.status == "RUNNING":
            raise HTTPException(status_code=400, detail="Task is still running")

    if not task:
        # Create new task
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
                    "gitUrl": request.git_url or "",
                    "gitRepo": request.git_repo or "",
                    "gitRepoId": request.git_repo_id or 0,
                    "gitDomain": request.git_domain or "",
                    "branchName": request.branch_name or "",
                }
            },
            "status": {"state": "Available"},
            "metadata": {"name": workspace_name, "namespace": "default"},
            "apiVersion": "agent.wecode.io/v1",
        }

        workspace = Kind(
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
        if request.title:
            title = request.title
        else:
            title = message[:50] + "..." if len(message) > 50 else message

        # Auto-detect task type based on git_url presence
        task_type = "code" if request.git_url else "chat"

        # Log the is_group_chat value being set
        logger.info(
            f"[_create_task_and_subtasks] Creating task_json with is_group_chat={request.is_group_chat}"
        )

        task_json = {
            "kind": "Task",
            "spec": {
                "title": title,
                "prompt": message,
                "teamRef": {"name": team.name, "namespace": team.namespace},
                "workspaceRef": {"name": workspace_name, "namespace": "default"},
                "is_group_chat": request.is_group_chat,
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
                    **({"modelId": request.model_id} if request.model_id else {}),
                    **(
                        {"forceOverrideBotModel": "true"}
                        if request.force_override_bot_model
                        else {}
                    ),
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        }

        task = Kind(
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

        # Log the created task_json to verify is_group_chat was saved correctly
        logger.info(
            f"[_create_task_and_subtasks] Created task {new_task_id} with task_json.spec.is_group_chat="
            f"{task_json.get('spec', {}).get('is_group_chat', 'NOT_SET')}"
        )

    # Get existing subtasks to determine message_id
    # Use subtask_user_id to see all messages (for group chats, this is task owner's ID)
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

    # Create USER subtask (always created)
    from app.models.subtask import SenderType

    user_subtask = Subtask(
        user_id=subtask_user_id,  # Use task owner's ID for group chats
        task_id=task_id,
        team_id=team.id,
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
        sender_user_id=user.id,  # Record the actual sender user ID
    )
    db.add(user_subtask)

    # Create ASSISTANT subtask only if AI should be triggered
    assistant_subtask = None
    if should_trigger_ai:
        # Note: completed_at is set to a placeholder value because the DB column doesn't allow NULL
        # It will be updated when the stream completes
        assistant_subtask = Subtask(
            user_id=subtask_user_id,  # Use task owner's ID for group chats
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
            completed_at=datetime.now(),  # Placeholder, will be updated when stream completes
            sender_type=SenderType.TEAM,
            sender_user_id=0,  # AI has no user_id, use 0 instead of None
        )
        db.add(assistant_subtask)

    # Update task.updated_at for group chat messages (even without AI trigger)
    # This ensures the task list shows unread indicators for new messages
    if request.is_group_chat or task.json.get("spec", {}).get("is_group_chat", False):
        from sqlalchemy.orm.attributes import flag_modified

        task.updated_at = datetime.now()
        # Also update the JSON status.updatedAt for consistency
        task_crd = Task.model_validate(task.json)
        if task_crd.status:
            task_crd.status.updatedAt = datetime.now()
            task.json = task_crd.model_dump(mode="json")
            flag_modified(task, "json")

    db.commit()
    db.refresh(task)
    db.refresh(user_subtask)
    if assistant_subtask:
        db.refresh(assistant_subtask)

    # Initialize Redis chat history from existing subtasks if needed
    # This is crucial for shared tasks that were copied with historical messages
    if existing_subtasks:
        from app.services.chat.session_manager import session_manager

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

    # Notify all group chat members about the new message via WebSocket
    # This allows their task list to show the unread indicator
    if request.is_group_chat or task.json.get("spec", {}).get("is_group_chat", False):
        await _notify_group_members_task_updated(db, task, user.id)

    return {
        "task": task,
        "user_subtask": user_subtask,
        "assistant_subtask": assistant_subtask,
        "ai_triggered": should_trigger_ai,
        "rag_prompt": rag_prompt,  # Return RAG prompt for AI inference
    }


async def _notify_group_members_task_updated(
    db: Session, task: Kind, sender_user_id: int
) -> None:
    """
    Notify all group chat members about task update via WebSocket.

    This sends a task:status event to each member's user room so their
    task list can show the unread indicator for new messages.

    Args:
        db: Database session
        task: Task Kind object
        sender_user_id: User ID of the message sender (to exclude from notification)
    """
    from app.models.task_member import MemberStatus, TaskMember
    from app.services.chat.ws_emitter import get_ws_emitter

    ws_emitter = get_ws_emitter()
    if not ws_emitter:
        logger.warning(
            f"[_notify_group_members_task_updated] WebSocket emitter not available"
        )
        return

    try:
        # Get all active members of this group chat
        members = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task.id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .all()
        )

        # Also include the task owner
        member_user_ids = {m.user_id for m in members}
        member_user_ids.add(task.user_id)

        # Get current task status
        task_crd = Task.model_validate(task.json)
        current_status = task_crd.status.status if task_crd.status else "PENDING"

        # Notify each member (except the sender) about the task update
        for member_user_id in member_user_ids:
            if member_user_id == sender_user_id:
                # Skip the sender - they already know about their own message
                continue

            await ws_emitter.emit_task_status(
                user_id=member_user_id,
                task_id=task.id,
                status=current_status,
                progress=task_crd.status.progress if task_crd.status else 0,
            )
            logger.debug(
                f"[_notify_group_members_task_updated] Notified user {member_user_id} about task {task.id} update"
            )

    except Exception as e:
        logger.warning(
            f"[_notify_group_members_task_updated] Failed to notify group members: {e}"
        )


@router.post("/stream")
async def stream_chat(
    request: StreamChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Stream chat response for Chat Shell type.

    This endpoint directly calls LLM APIs without going through Docker Executor.
    Only works for teams where all bots use Chat Shell type.

    Supports file attachments via attachment_id parameter. When provided,
    the attachment's extracted text will be prepended to the user message.

    **Offset-based Resume Mode:**
    When `subtask_id` and `offset` are provided, the endpoint enters resume mode:
    - Fetches cached content from Redis/DB
    - Sends content from `offset` position onwards
    - Subscribes to Pub/Sub for real-time updates
    - Each chunk includes `offset` for client-side tracking

    Returns SSE stream with the following events:
    - {"task_id": int, "subtask_id": int, "offset": 0, "content": "", "done": false} - First message with IDs
    - {"offset": int, "content": "...", "done": false} - Content chunks with offset
    - {"offset": int, "content": "", "done": true, "result": {...}} - Completion
    - {"error": "..."} - Error message
    """
    import json

    from fastapi.responses import StreamingResponse

    # Check if this is a resume request
    if request.subtask_id is not None and request.offset is not None:
        return await _handle_resume_stream(
            request.subtask_id,
            request.offset,
            db,
            current_user,
        )

    # Validate team exists
    team = (
        db.query(Kind)
        .filter(
            Kind.id == request.team_id,
            Kind.kind == "Team",
            Kind.is_active == True,
        )
        .first()
    )

    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    # Check if team supports direct chat
    if not _should_use_direct_chat(db, team, current_user.id):
        raise HTTPException(
            status_code=400,
            detail="This team does not support direct chat. Please use the task API instead.",
        )

    # Handle attachment if provided
    attachment = None
    final_message = request.message
    if request.attachment_id:
        from app.models.subtask_attachment import AttachmentStatus
        from app.services.attachment import attachment_service

        attachment = attachment_service.get_attachment(
            db=db,
            attachment_id=request.attachment_id,
            user_id=current_user.id,
        )

        if attachment is None:
            raise HTTPException(status_code=404, detail="Attachment not found")

        if attachment.status != AttachmentStatus.READY:
            raise HTTPException(
                status_code=400,
                detail=f"Attachment is not ready: {attachment.status.value}",
            )

        # Build message with attachment content
        final_message = attachment_service.build_message_with_attachment(
            request.message, attachment
        )

    # Prepare web search tool definition if enabled
    tools = None
    if request.enable_web_search:
        from app.core.config import settings
        from app.services.chat.tools import get_web_search_tool

        # Check if web search is enabled globally
        if settings.WEB_SEARCH_ENABLED:
            # Get web search tool
            web_search_tool = get_web_search_tool(engine_name=request.search_engine)
            if web_search_tool:
                tools = [web_search_tool]
        else:
            logger.warning("Web search requested but disabled in configuration")

    # Get or create task first to check group chat mode and team name
    task_kind = None
    task_json = {}
    team_name = team.name

    if request.task_id:
        # Get existing task - first try as owner
        task_kind = (
            db.query(Kind)
            .filter(
                Kind.id == request.task_id,
                Kind.user_id == current_user.id,
                Kind.kind == "Task",
                Kind.is_active,
            )
            .first()
        )

        # If not found as owner, check if user is a group chat member
        if not task_kind:
            from app.models.task_member import MemberStatus, TaskMember

            member = (
                db.query(TaskMember)
                .filter(
                    TaskMember.task_id == request.task_id,
                    TaskMember.user_id == current_user.id,
                    TaskMember.status == MemberStatus.ACTIVE,
                )
                .first()
            )

            if member:
                # User is a group member, get task without user_id check
                task_kind = (
                    db.query(Kind)
                    .filter(
                        Kind.id == request.task_id,
                        Kind.kind == "Task",
                        Kind.is_active,
                    )
                    .first()
                )

        # If task found, get its JSON
        if task_kind:
            task_json = task_kind.json or {}

    # Check if AI should be triggered (for group chat with @mention)
    # Pass request.is_group_chat for new tasks where task_json is empty
    should_trigger_ai = _should_trigger_ai_response(
        task_json, request.message, team_name, request.is_group_chat
    )
    logger.info(
        f"Group chat check: task_id={request.task_id}, "
        f"task_kind_found={task_kind is not None}, "
        f"task_json_spec={task_json.get('spec', {})}, "
        f"is_group_chat={task_json.get('spec', {}).get('is_group_chat', False)}, "
        f"team_name={team_name}, "
        f"message_preview={request.message[:50] if request.message else ''}, "
        f"message_contains_mention={'@' + team_name in request.message}, "
        f"should_trigger_ai={should_trigger_ai}"
    )

    # Log the request.is_group_chat value before creating task
    logger.info(
        f"[stream_chat] Before creating task - request.is_group_chat={request.is_group_chat}, "
        f"request={request.model_dump()}"
    )

    # Create task and subtasks (use original message for storage, final_message for LLM)
    result = await _create_task_and_subtasks(
        db,
        current_user,
        team,
        request.message,
        request,
        request.task_id,
        should_trigger_ai=should_trigger_ai,
    )

    task = result["task"]
    user_subtask = result["user_subtask"]
    assistant_subtask = result["assistant_subtask"]
    ai_triggered = result["ai_triggered"]

    # Link attachment to the user subtask if provided
    # This must be done before the early return for non-AI-triggered messages
    # to ensure attachments are visible in group chat even without @mention
    if attachment:
        from app.services.attachment import attachment_service

        attachment_service.link_attachment_to_subtask(
            db=db,
            attachment_id=attachment.id,
            subtask_id=user_subtask.id,
            user_id=current_user.id,
        )

    # If AI not triggered, return early with message saved response
    if not ai_triggered:

        async def no_ai_response():
            yield f"data: {json.dumps({'task_id': task.id, 'subtask_id': user_subtask.id, 'content': '', 'done': True, 'ai_triggered': False, 'message': 'Message saved without AI response'})}\n\n"

        return StreamingResponse(
            no_ai_response(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
                "X-Task-Id": str(task.id),
                "X-Subtask-Id": str(user_subtask.id),
            },
        )

    # Set task context for OpenTelemetry tracing after task/subtask creation
    from app.api.dependencies import _set_telemetry_task_context

    _set_telemetry_task_context(task_id=task.id, subtask_id=assistant_subtask.id)

    # Get first bot for model config and system prompt
    team_crd = Team.model_validate(team.json)
    first_member = team_crd.spec.members[0]

    bot = (
        db.query(Kind)
        .filter(
            Kind.user_id == team.user_id,
            Kind.kind == "Bot",
            Kind.name == first_member.botRef.name,
            Kind.namespace == first_member.botRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if not bot:
        raise HTTPException(status_code=400, detail="Bot not found")

    # Get model config
    try:
        model_config = get_model_config_for_bot(
            db,
            bot,
            team.user_id,
            override_model_name=request.model_id,
            force_override=request.force_override_bot_model,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Get system prompt
    system_prompt = get_bot_system_prompt(db, bot, team.user_id, first_member.prompt)

    # Append clarification mode instructions if enabled
    from app.services.chat.clarification_prompt import append_clarification_prompt

    system_prompt = append_clarification_prompt(
        system_prompt, request.enable_clarification
    )

    # Build data_sources for placeholder replacement in DEFAULT_HEADERS
    # This mirrors the executor's member_builder.py logic
    bot_crd = Bot.model_validate(bot.json)
    bot_json = bot.json or {}
    bot_spec = bot_json.get("spec", {})
    agent_config = bot_spec.get("agent_config", {})

    # Get user info for data sources
    # Note: Use "name" key to match executor's task_data.user.name format
    user_info = {
        "id": current_user.id,
        "name": current_user.user_name or "",
        "user_name": current_user.user_name
        or "",  # Also include user_name for compatibility
    }

    # Build task_data similar to executor format
    task_data = {
        "task_id": task.id,
        "team_id": team.id,
        "user": user_info,
        "git_url": request.git_url or "",
        "git_repo": request.git_repo or "",
        "git_domain": request.git_domain or "",
        "branch_name": request.branch_name or "",
        "prompt": request.message,
    }

    # Build data_sources for placeholder replacement
    data_sources = {
        "agent_config": agent_config,
        "model_config": model_config,  # Contains api_key, base_url, model_id, etc.
        "task_data": task_data,
        "user": user_info,
        "env": model_config.get("default_headers", {}),  # For backward compatibility
    }

    # Process DEFAULT_HEADERS with placeholder replacement
    raw_default_headers = model_config.get("default_headers", {})

    logger.info(f"Raw default headers before processing: {raw_default_headers}")
    logger.info(f"Data sources for header processing: {data_sources}")

    if raw_default_headers:
        processed_headers = build_default_headers_with_placeholders(
            raw_default_headers, data_sources
        )
        model_config["default_headers"] = processed_headers

    logger.info(f"Streaming chat for model_config={model_config}")

    # Create streaming response with task_id and subtask_id in first message
    import json

    from fastapi.responses import StreamingResponse

    async def generate_with_ids():
        from app.services.chat.session_manager import session_manager

        # Set task-level streaming status for group chat
        task_json = task.json or {}
        is_group_chat = task_json.get("spec", {}).get("is_group_chat", False)
        if is_group_chat:
            await session_manager.set_task_streaming_status(
                task_id=task.id,
                subtask_id=assistant_subtask.id,
                user_id=current_user.id,
                username=current_user.user_name,
            )

        try:
            # Send first message with IDs
            first_msg = {
                "task_id": task.id,
                "subtask_id": assistant_subtask.id,
                "content": "",
                "done": False,
            }
            yield f"data: {json.dumps(first_msg)}\n\n"

            # Get the actual stream from chat service (use final_message with attachment content)
            stream_response = await chat_service.chat_stream(
                subtask_id=assistant_subtask.id,
                task_id=task.id,
                message=final_message,
                model_config=model_config,
                system_prompt=system_prompt,
                tools=tools,
                is_group_chat=is_group_chat,
            )

            # Forward the stream
            async for chunk in stream_response.body_iterator:
                yield chunk
        finally:
            # Clear task-level streaming status when done
            if is_group_chat:
                await session_manager.clear_task_streaming_status(task.id)

    return StreamingResponse(
        generate_with_ids(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            # Return task_id and subtask_id in headers for immediate access
            "X-Task-Id": str(task.id),
            "X-Subtask-Id": str(assistant_subtask.id),
        },
    )


async def _handle_resume_stream(
    subtask_id: int,
    offset: int,
    db: Session,
    current_user: User,
):
    """
    Handle resume/reconnect stream request with offset-based continuation.

    This function implements the offset-based streaming protocol:
    1. Verify subtask ownership/membership and status
    2. Get cached content from Redis/DB
    3. Send content from offset position onwards
    4. Subscribe to Pub/Sub for real-time updates
    5. Each chunk includes offset for client-side tracking

    Args:
        subtask_id: The subtask ID to resume
        offset: Character offset to resume from (0 = send all cached content)
        db: Database session
        current_user: Current authenticated user

    Returns:
        StreamingResponse with offset-based SSE events
    """
    import json

    from fastapi.responses import StreamingResponse

    from app.models.task_member import MemberStatus, TaskMember
    from app.services.chat.session_manager import session_manager

    # Verify subtask ownership first
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.user_id == current_user.id,
        )
        .first()
    )

    # If not found as owner, check if user is a group chat member
    if not subtask:
        # First get the subtask without user_id filter to check task membership
        subtask_any = db.query(Subtask).filter(Subtask.id == subtask_id).first()

        if subtask_any:
            # Check if user is a group chat member for this task
            member = (
                db.query(TaskMember)
                .filter(
                    TaskMember.task_id == subtask_any.task_id,
                    TaskMember.user_id == current_user.id,
                    TaskMember.status == MemberStatus.ACTIVE,
                )
                .first()
            )

            if member:
                # User is a group member, allow access
                subtask = subtask_any

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Check subtask status
    if subtask.status == SubtaskStatus.COMPLETED:
        # Already completed - send final content
        content = ""
        if subtask.result:
            content = subtask.result.get("value", "")

        async def generate_completed():
            # Send content from offset
            if offset < len(content):
                remaining = content[offset:]
                yield f"data: {json.dumps({'offset': offset, 'content': remaining, 'done': False})}\n\n"

            # Send completion
            yield f"data: {json.dumps({'offset': len(content), 'content': '', 'done': True, 'result': subtask.result})}\n\n"

        return StreamingResponse(
            generate_completed(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
                "X-Task-Id": str(subtask.task_id),
                "X-Subtask-Id": str(subtask_id),
            },
        )

    if subtask.status == SubtaskStatus.FAILED:
        raise HTTPException(
            status_code=400, detail=f"Subtask failed: {subtask.error_message}"
        )

    if subtask.status not in [SubtaskStatus.RUNNING, SubtaskStatus.PENDING]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot resume stream for subtask in {subtask.status.value} state",
        )

    async def generate_resume():
        import asyncio

        current_offset = offset

        try:
            # 1. Get cached content from Redis first
            cached_content = await session_manager.get_streaming_content(subtask_id)

            # If no Redis content, try database
            if not cached_content and subtask.result:
                cached_content = subtask.result.get("value", "")

            # 2. Send cached content from offset position
            if cached_content and current_offset < len(cached_content):
                remaining = cached_content[current_offset:]
                yield f"data: {json.dumps({'offset': current_offset, 'content': remaining, 'done': False, 'cached': True})}\n\n"
                current_offset = len(cached_content)

            # Check if subtask already completed before subscribing
            db.refresh(subtask)
            if subtask.status == SubtaskStatus.COMPLETED:
                final_content = ""
                if subtask.result:
                    final_content = subtask.result.get("value", "")

                # Send any remaining content
                if current_offset < len(final_content):
                    remaining = final_content[current_offset:]
                    yield f"data: {json.dumps({'offset': current_offset, 'content': remaining, 'done': False})}\n\n"
                    current_offset = len(final_content)

                yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': subtask.result})}\n\n"
                return

            if subtask.status == SubtaskStatus.FAILED:
                yield f"data: {json.dumps({'error': f'Subtask failed: {subtask.error_message}'})}\n\n"
                return

            # 3. Subscribe to Redis Pub/Sub for real-time updates
            redis_client, pubsub = await session_manager.subscribe_streaming_channel(
                subtask_id
            )
            if not pubsub:
                # No pub/sub available - check if stream is still active
                # If not, the stream might have completed while we were connecting
                logger.warning(
                    f"Could not subscribe to streaming channel for subtask {subtask_id}"
                )

                # Re-check subtask status
                db.refresh(subtask)
                if subtask.status == SubtaskStatus.COMPLETED:
                    final_content = ""
                    if subtask.result:
                        final_content = subtask.result.get("value", "")

                    # Send any remaining content
                    if current_offset < len(final_content):
                        remaining = final_content[current_offset:]
                        yield f"data: {json.dumps({'offset': current_offset, 'content': remaining, 'done': False})}\n\n"
                        current_offset = len(final_content)

                    yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': subtask.result})}\n\n"
                else:
                    yield f"data: {json.dumps({'error': 'Stream not available'})}\n\n"
                return

            try:
                # 4. Listen for new chunks with timeout and status check
                last_status_check = asyncio.get_event_loop().time()
                status_check_interval = 2.0  # Check status every 2 seconds

                while True:
                    try:
                        # Use get_message with timeout instead of listen()
                        message = await asyncio.wait_for(
                            pubsub.get_message(
                                ignore_subscribe_messages=True, timeout=1.0
                            ),
                            timeout=2.0,
                        )

                        if message and message["type"] == "message":
                            chunk = message["data"]
                            if isinstance(chunk, bytes):
                                chunk = chunk.decode("utf-8")
                            # Check for stream done signal (now JSON format with result)
                            # Try to parse as JSON first
                            try:
                                done_data = json.loads(chunk)
                                # Ensure it's a dict before checking __type__
                                if (
                                    isinstance(done_data, dict)
                                    and done_data.get("__type__") == "STREAM_DONE"
                                ):
                                    # Extract result directly from Pub/Sub message
                                    final_result = done_data.get("result")
                                    yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': final_result})}\n\n"
                                    break
                            except json.JSONDecodeError:
                                pass  # Not JSON, treat as regular chunk
                                pass  # Not JSON, treat as regular chunk

                            # Legacy support: check for old format
                            if chunk == "__STREAM_DONE__":
                                # Fallback to database for old format
                                db.refresh(subtask)
                                yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': subtask.result})}\n\n"
                                break

                            # Send new chunk with offset
                            yield f"data: {json.dumps({'offset': current_offset, 'content': chunk, 'done': False})}\n\n"
                            current_offset += len(chunk)

                    except asyncio.TimeoutError:
                        pass  # Timeout is expected, continue to status check

                    # Periodically check subtask status in case we missed the done signal
                    current_time = asyncio.get_event_loop().time()
                    if current_time - last_status_check >= status_check_interval:
                        last_status_check = current_time
                        db.refresh(subtask)

                        if subtask.status == SubtaskStatus.COMPLETED:
                            # Status check detected completion - get result from database
                            # This is a fallback path when Pub/Sub message was missed
                            final_result = subtask.result

                            final_content = ""
                            if final_result:
                                final_content = final_result.get("value", "")

                            # Send any remaining content
                            if current_offset < len(final_content):
                                remaining = final_content[current_offset:]
                                yield f"data: {json.dumps({'offset': current_offset, 'content': remaining, 'done': False})}\n\n"
                                current_offset = len(final_content)

                            yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': final_result})}\n\n"
                            break

                        if subtask.status == SubtaskStatus.FAILED:
                            yield f"data: {json.dumps({'error': f'Subtask failed: {subtask.error_message}'})}\n\n"
                            break

                        if subtask.status not in [
                            SubtaskStatus.RUNNING,
                            SubtaskStatus.PENDING,
                        ]:
                            yield f"data: {json.dumps({'error': f'Unexpected subtask status: {subtask.status.value}'})}\n\n"
                            break
            finally:
                # Cleanup: unsubscribe and close client
                await pubsub.unsubscribe()
                await pubsub.close()
                if redis_client:
                    await redis_client.aclose()

        except Exception as e:
            logger.error(
                f"Error in resume stream for subtask {subtask_id}: {e}", exc_info=True
            )
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate_resume(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Task-Id": str(subtask.task_id),
            "X-Subtask-Id": str(subtask_id),
        },
    )


@router.get("/check-direct-chat/{team_id}")
async def check_direct_chat(
    team_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Check if a team supports direct chat mode.

    Returns:
        {"supports_direct_chat": bool, "shell_type": str}
    """
    team = (
        db.query(Kind)
        .filter(
            Kind.id == team_id,
            Kind.kind == "Team",
            Kind.is_active == True,
        )
        .first()
    )

    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    supports_direct_chat = _should_use_direct_chat(db, team, current_user.id)

    # Get shell type of first bot
    shell_type = ""
    team_crd = Team.model_validate(team.json)
    if team_crd.spec.members:
        first_member = team_crd.spec.members[0]
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == first_member.botRef.name,
                Kind.namespace == first_member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if bot:
            shell_type = _get_shell_type(db, bot, team.user_id)

    return {
        "supports_direct_chat": supports_direct_chat,
        "shell_type": shell_type,
    }


class CancelChatRequest(BaseModel):
    """Request body for cancelling a chat stream."""

    subtask_id: int
    partial_content: str | None = None  # Partial content received before cancellation


@router.post("/cancel")
async def cancel_chat(
    request: CancelChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Cancel an ongoing chat stream.

    For Chat Shell type, this endpoint:
    - Signals the streaming loop to stop via cancellation event
    - Updates the subtask status to COMPLETED (not CANCELLED) to show the truncated message
    - Saves the partial content received before cancellation
    - Updates the task status to COMPLETED so the conversation can continue

    This allows users to see the partial response and continue the conversation.

    Returns:
        {"success": bool, "message": str}
    """
    # Find the subtask
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == request.subtask_id,
            Subtask.user_id == current_user.id,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Check if subtask is in a cancellable state
    if subtask.status not in [SubtaskStatus.PENDING, SubtaskStatus.RUNNING]:
        return {
            "success": False,
            "message": f"Subtask is already in {subtask.status.value} state",
        }

    # Signal the streaming loop to stop via Redis (cross-worker)
    # This will cause the LLM API call to be interrupted
    from app.services.chat.session_manager import session_manager

    await session_manager.cancel_stream(request.subtask_id)

    # For Chat Shell, we mark as COMPLETED instead of CANCELLED
    # This allows the truncated message to be displayed normally
    # and the user can continue the conversation
    subtask.status = SubtaskStatus.COMPLETED
    subtask.progress = 100
    subtask.completed_at = datetime.now()
    subtask.updated_at = datetime.now()
    # Don't set error_message for stopped chat - it's not an error
    subtask.error_message = ""

    # Save partial content if provided
    if request.partial_content:
        subtask.result = {"value": request.partial_content}
    else:
        # If no partial content, set empty result
        subtask.result = {"value": ""}

    # Also update the task status to COMPLETED so conversation can continue
    task = (
        db.query(Kind)
        .filter(
            Kind.id == subtask.task_id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if task:
        from sqlalchemy.orm.attributes import flag_modified

        task_crd = Task.model_validate(task.json)
        if task_crd.status:
            # Set to COMPLETED instead of CANCELLED
            # This allows the user to continue the conversation
            task_crd.status.status = "COMPLETED"
            task_crd.status.errorMessage = ""  # No error message for stopped chat
            task_crd.status.updatedAt = datetime.now()
            task_crd.status.completedAt = datetime.now()

        task.json = task_crd.model_dump(mode="json")
        task.updated_at = datetime.now()
        flag_modified(task, "json")

    db.commit()

    return {"success": True, "message": "Chat stopped successfully"}


@router.get("/streaming-content/{subtask_id}")
async def get_streaming_content(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get streaming content for a subtask (from Redis or DB).

    Used for recovery when user refreshes during streaming.
    This endpoint tries to get the most recent content from:
    1. Redis streaming cache (most recent, updated every 1 second)
    2. Database result field (fallback, updated every 5 seconds)

    Returns:
        {
            "content": str,           # The accumulated content
            "source": str,            # "redis" or "database"
            "streaming": bool,        # Whether still streaming
            "status": str,            # Subtask status
            "incomplete": bool        # Whether content is incomplete (client disconnected)
        }
    """
    from app.models.task_member import MemberStatus, TaskMember

    # Verify subtask ownership first
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.user_id == current_user.id,
        )
        .first()
    )

    # If not found as owner, check if user is a group chat member
    if not subtask:
        # First get the subtask without user_id filter to check task membership
        subtask_any = db.query(Subtask).filter(Subtask.id == subtask_id).first()

        if subtask_any:
            # Check if user is a group chat member for this task
            member = (
                db.query(TaskMember)
                .filter(
                    TaskMember.task_id == subtask_any.task_id,
                    TaskMember.user_id == current_user.id,
                    TaskMember.status == MemberStatus.ACTIVE,
                )
                .first()
            )

            if member:
                # User is a group member, allow access
                subtask = subtask_any

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # 1. Try to get from Redis first (most recent)
    from app.services.chat.session_manager import session_manager

    redis_content = await session_manager.get_streaming_content(subtask_id)

    if redis_content:
        return {
            "content": redis_content,
            "source": "redis",
            "streaming": True,
            "status": subtask.status.value,
            "incomplete": False,
        }

    # 2. Fallback to database
    db_content = ""
    is_streaming = False
    is_incomplete = False

    if subtask.result:
        db_content = subtask.result.get("value", "")
        is_streaming = subtask.result.get("streaming", False)
        is_incomplete = subtask.result.get("incomplete", False)

    return {
        "content": db_content,
        "source": "database",
        "streaming": is_streaming,
        "status": subtask.status.value,
        "incomplete": is_incomplete,
    }


@router.get("/resume-stream/{subtask_id}")
async def resume_stream(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Resume streaming for a running subtask after page refresh.

    This endpoint allows users to refresh the page and continue receiving
    streaming content from an ongoing Chat Shell task, similar to OpenAI's implementation.

    Flow:
    1. Verify subtask ownership/membership and status (must be RUNNING)
    2. Send cached content from Redis immediately
    3. Subscribe to Redis Pub/Sub channel for real-time updates
    4. Continue streaming new content as it arrives
    5. End stream when "__STREAM_DONE__" signal is received

    Returns SSE stream with:
    - {"content": "...", "done": false, "cached": true} - Cached content (first message)
    - {"content": "...", "done": false} - New streaming content
    - {"content": "", "done": true} - Stream completion
    """
    import json

    from fastapi.responses import StreamingResponse

    from app.models.task_member import MemberStatus, TaskMember

    # Verify subtask ownership first
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.user_id == current_user.id,
        )
        .first()
    )

    # If not found as owner, check if user is a group chat member
    if not subtask:
        # First get the subtask without user_id filter to check task membership
        subtask_any = db.query(Subtask).filter(Subtask.id == subtask_id).first()

        if subtask_any:
            # Check if user is a group chat member for this task
            member = (
                db.query(TaskMember)
                .filter(
                    TaskMember.task_id == subtask_any.task_id,
                    TaskMember.user_id == current_user.id,
                    TaskMember.status == MemberStatus.ACTIVE,
                )
                .first()
            )

            if member:
                # User is a group member, allow access
                subtask = subtask_any

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Only allow resuming RUNNING subtasks
    if subtask.status != SubtaskStatus.RUNNING:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot resume stream for subtask in {subtask.status.value} state",
        )

    async def generate_resume():
        import asyncio

        from app.services.chat.session_manager import session_manager

        try:
            # 1. Send cached content first (from Redis)
            cached_content = await session_manager.get_streaming_content(subtask_id)
            if cached_content:
                yield f"data: {json.dumps({'content': cached_content, 'done': False, 'cached': True})}\n\n"

            # Check if subtask already completed before subscribing
            db.refresh(subtask)
            if subtask.status == SubtaskStatus.COMPLETED:
                yield f"data: {json.dumps({'content': '', 'done': True, 'result': subtask.result})}\n\n"
                return

            if subtask.status == SubtaskStatus.FAILED:
                yield f"data: {json.dumps({'error': f'Subtask failed: {subtask.error_message}'})}\n\n"
                return

            # 2. Subscribe to Redis Pub/Sub for real-time updates
            redis_client, pubsub = await session_manager.subscribe_streaming_channel(
                subtask_id
            )
            if not pubsub:
                # No pub/sub available - check if stream completed
                logger.warning(
                    f"Could not subscribe to streaming channel for subtask {subtask_id}"
                )
                db.refresh(subtask)
                if subtask.status == SubtaskStatus.COMPLETED:
                    yield f"data: {json.dumps({'content': '', 'done': True, 'result': subtask.result})}\n\n"
                else:
                    yield f"data: {json.dumps({'content': '', 'done': True, 'error': 'Stream not available'})}\n\n"
                return

            try:
                # 3. Listen for new chunks with timeout and status check
                last_status_check = asyncio.get_event_loop().time()
                status_check_interval = 2.0  # Check status every 2 seconds

                while True:
                    try:
                        # Use get_message with timeout instead of listen()
                        message = await asyncio.wait_for(
                            pubsub.get_message(
                                ignore_subscribe_messages=True, timeout=1.0
                            ),
                            timeout=2.0,
                        )

                        if message and message["type"] == "message":
                            chunk = message["data"]
                            if isinstance(chunk, bytes):
                                chunk = chunk.decode("utf-8")

                            # Check for stream done signal (now JSON format with result)
                            try:
                                done_data = json.loads(chunk)
                                # Ensure it's a dict before checking __type__
                                if (
                                    isinstance(done_data, dict)
                                    and done_data.get("__type__") == "STREAM_DONE"
                                ):
                                    # Extract result directly from Pub/Sub message
                                    final_result = done_data.get("result")
                                    yield f"data: {json.dumps({'content': '', 'done': True, 'result': final_result})}\n\n"
                                    break
                            except json.JSONDecodeError:
                                pass  # Not JSON, treat as regular chunk

                            # Legacy support: check for old format
                            if chunk == "__STREAM_DONE__":
                                yield f"data: {json.dumps({'content': '', 'done': True})}\n\n"
                                break

                            # Send new chunk
                            yield f"data: {json.dumps({'content': chunk, 'done': False})}\n\n"

                    except asyncio.TimeoutError:
                        pass  # Timeout is expected, continue to status check

                    # Periodically check subtask status in case we missed the done signal
                    current_time = asyncio.get_event_loop().time()
                    if current_time - last_status_check >= status_check_interval:
                        last_status_check = current_time
                        db.refresh(subtask)

                        if subtask.status == SubtaskStatus.COMPLETED:
                            yield f"data: {json.dumps({'content': '', 'done': True, 'result': subtask.result})}\n\n"
                            break

                        if subtask.status == SubtaskStatus.FAILED:
                            yield f"data: {json.dumps({'error': f'Subtask failed: {subtask.error_message}'})}\n\n"
                            break

                        if subtask.status not in [
                            SubtaskStatus.RUNNING,
                            SubtaskStatus.PENDING,
                        ]:
                            yield f"data: {json.dumps({'error': f'Unexpected subtask status: {subtask.status.value}'})}\n\n"
                            break
            finally:
                # Cleanup: unsubscribe and close client
                await pubsub.unsubscribe()
                await pubsub.close()
                if redis_client:
                    await redis_client.aclose()

        except Exception as e:
            logger.error(
                f"Error in resume_stream for subtask {subtask_id}: {e}", exc_info=True
            )
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate_resume(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "none",
        },
    )


@router.get("/search-engines")
async def get_search_engines(
    current_user: User = Depends(security.get_current_user),
):
    """
    Get available search engines from configuration.

    Returns:
        {
            "enabled": bool,
            "engines": [{"name": str, "display_name": str}]
        }
    """
    from app.core.config import settings
    from app.services.search.factory import get_available_engines

    if not settings.WEB_SEARCH_ENABLED:
        return {"enabled": False, "engines": []}

    # Get available engines from factory
    engines = get_available_engines()

    return {
        "enabled": True,
        "engines": engines,
    }


# AI Correction Feature
class CorrectionRequest(BaseModel):
    """Request body for AI correction."""

    task_id: int
    message_id: int
    original_question: str
    original_answer: str
    correction_model_id: str
    force_retry: bool = False  # Force re-evaluation even if correction exists
    enable_web_search: bool = False  # Enable web search tool for fact verification
    search_engine: Optional[str] = None  # Search engine name to use


@router.post("/correct")
async def correct_response(
    request: CorrectionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Evaluate and correct an AI response using a specified correction model.

    This endpoint:
    1. Validates the correction model exists and is accessible
    2. Checks if correction already exists in subtask.result (returns cached)
    3. If not cached, sends the original Q&A to the correction model for evaluation
    4. Saves correction result to subtask.result.correction for persistence
    5. Returns scores, corrections, summary, and improved answer

    Returns:
        {
            "message_id": int,
            "scores": {"accuracy": int, "logic": int, "completeness": int},
            "corrections": [{"issue": str, "suggestion": str}],
            "summary": str,
            "improved_answer": str,
            "is_correct": bool
        }
    """
    from datetime import datetime

    from app.models.subtask import Subtask, SubtaskRole
    from app.services.correction_service import correction_service

    # Validate that the task belongs to the current user
    task = (
        db.query(Kind)
        .filter(
            Kind.id == request.task_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if not task:
        # Check if user is a group chat member
        from app.models.task_member import MemberStatus, TaskMember

        member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == request.task_id,
                TaskMember.user_id == current_user.id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=404, detail="Task not found")

    # Get the subtask (AI message) to check for existing correction
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == request.message_id,
            Subtask.task_id == request.task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="AI message not found")

    # Check for existing correction in result
    result = subtask.result or {}
    existing_correction = result.get("correction") if isinstance(result, dict) else None

    # Return cached result only if not forcing retry
    if existing_correction and not request.force_retry:
        # Return cached result
        return {
            "message_id": subtask.id,
            "scores": existing_correction.get("scores", {}),
            "corrections": existing_correction.get("corrections", []),
            "summary": existing_correction.get("summary", ""),
            "improved_answer": existing_correction.get("improved_answer", ""),
            "is_correct": existing_correction.get("is_correct", False),
        }

    # Get the correction model config
    # First check if it's a public model (user_id=0 in kinds table)
    public_model = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Model",
            Kind.name == request.correction_model_id,
            Kind.is_active == True,
        )
        .first()
    )

    model_config = None
    if public_model and public_model.json:
        # Public models store config in json.spec.modelConfig.env
        spec = public_model.json.get("spec", {})
        model_config_data = spec.get("modelConfig", {})
        env = model_config_data.get("env", {})
        model_config = {
            "provider": env.get("model", "openai"),
            "model_id": env.get("model_id", ""),
            "api_key": env.get("api_key", ""),
            "base_url": env.get("base_url"),
            "default_headers": env.get("custom_headers", {}),
        }
    else:
        # Try user-defined model
        user_model = (
            db.query(Kind)
            .filter(
                Kind.user_id == current_user.id,
                Kind.kind == "Model",
                Kind.name == request.correction_model_id,
                Kind.is_active == True,
            )
            .first()
        )

        if user_model and user_model.json:
            from app.schemas.kind import Model as ModelCRD

            model_crd = ModelCRD.model_validate(user_model.json)
            # modelConfig is a Dict[str, Any], so use dictionary access
            model_config_data = model_crd.spec.modelConfig
            env = model_config_data.get("env", {})
            model_config = {
                "provider": env.get("model", "openai"),
                "model_id": env.get("model_id", ""),
                "api_key": env.get("api_key", ""),
                "base_url": env.get("base_url"),
                "default_headers": env.get("custom_headers") or {},
            }

    if not model_config:
        raise HTTPException(
            status_code=400,
            detail=f"Correction model '{request.correction_model_id}' not found",
        )

    # Decrypt API key if encrypted
    from shared.utils.crypto import decrypt_api_key

    model_config["api_key"] = decrypt_api_key(model_config["api_key"])

    # Build chat history from previous subtasks
    history: list[dict[str, str]] = []
    if subtask.message_id > 1:
        # Get all subtasks before this message
        previous_subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == request.task_id,
                Subtask.message_id < subtask.message_id,
                Subtask.status == SubtaskStatus.COMPLETED,
            )
            .order_by(Subtask.message_id.asc())
            .all()
        )

        for prev_subtask in previous_subtasks:
            if prev_subtask.role == SubtaskRole.USER:
                history.append({"role": "user", "content": prev_subtask.prompt or ""})
            elif prev_subtask.role == SubtaskRole.ASSISTANT:
                # Extract content from result
                content = ""
                if prev_subtask.result:
                    if isinstance(prev_subtask.result, dict):
                        content = prev_subtask.result.get("value", "")
                    elif isinstance(prev_subtask.result, str):
                        content = prev_subtask.result
                history.append({"role": "assistant", "content": content})

        logger.info(
            f"Built chat history with {len(history)} messages for correction of subtask {subtask.id}"
        )

    # Get search tool if enabled
    tools = None
    if request.enable_web_search:
        from app.services.chat.tools import get_web_search_tool

        search_tool = get_web_search_tool(engine_name=request.search_engine)
        if search_tool:
            tools = [search_tool]
            logger.info(
                f"Enabled web search tool for correction (engine: {request.search_engine or 'default'})"
            )
        else:
            logger.warning("Web search requested but search service not available")

    try:
        # Call correction service with history and tools
        llm_result = await correction_service.evaluate_response(
            original_question=request.original_question,
            original_answer=request.original_answer,
            model_config=model_config,
            history=history if history else None,
            tools=tools,
        )

        # Get model display name for persistence
        model_display_name = request.correction_model_id
        if public_model and public_model.json:
            model_display_name = (
                public_model.json.get("spec", {})
                .get("modelConfig", {})
                .get("env", {})
                .get("model_id", request.correction_model_id)
            )
        elif user_model and user_model.json:
            model_display_name = (
                user_model.json.get("spec", {})
                .get("modelConfig", {})
                .get("env", {})
                .get("model_id", request.correction_model_id)
            )

        # Save correction to subtask.result for persistence
        from sqlalchemy.orm.attributes import flag_modified

        subtask_result = subtask.result or {}
        if not isinstance(subtask_result, dict):
            subtask_result = {}

        subtask_result["correction"] = {
            "model_id": request.correction_model_id,
            "model_name": model_display_name,
            "scores": llm_result["scores"],
            "corrections": llm_result["corrections"],
            "summary": llm_result["summary"],
            "improved_answer": llm_result["improved_answer"],
            "is_correct": llm_result["is_correct"],
            "corrected_at": datetime.utcnow().isoformat() + "Z",
        }

        subtask.result = subtask_result
        flag_modified(subtask, "result")
        db.commit()

        logger.info(f"Saved correction result for subtask {subtask.id} to database")

        return {
            "message_id": request.message_id,
            "scores": llm_result["scores"],
            "corrections": llm_result["corrections"],
            "summary": llm_result["summary"],
            "improved_answer": llm_result["improved_answer"],
            "is_correct": llm_result["is_correct"],
        }

    except Exception as e:
        logger.error(f"Correction evaluation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Correction evaluation failed: {str(e)}",
        )


@router.delete("/subtasks/{subtask_id}/correction")
async def delete_correction(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete correction data from a subtask.

    This allows users to re-run correction with a different model.
    The correction data is stored in subtask.result.correction.
    """
    from sqlalchemy.orm.attributes import flag_modified

    # Get the subtask
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.role == SubtaskRole.ASSISTANT,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Verify user has access to the task
    task = (
        db.query(Kind)
        .filter(
            Kind.id == subtask.task_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if not task:
        # Check if user is a group chat member
        from app.models.task_member import MemberStatus, TaskMember

        member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == subtask.task_id,
                TaskMember.user_id == current_user.id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=403, detail="Access denied")

    # Remove correction from result
    result = subtask.result or {}
    if isinstance(result, dict) and "correction" in result:
        del result["correction"]
        subtask.result = result
        flag_modified(subtask, "result")
        db.commit()
        logger.info(f"Deleted correction for subtask {subtask_id}")

    return {"message": "Correction deleted"}


class ApplyCorrectionRequest(BaseModel):
    """Request body for applying correction to replace AI message."""

    improved_answer: str


@router.post("/subtasks/{subtask_id}/apply-correction")
async def apply_correction(
    subtask_id: int,
    request: ApplyCorrectionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Apply the improved answer from correction to replace the AI message content.

    This endpoint:
    1. Validates the subtask exists and user has access
    2. Updates subtask.result.value with the improved answer
    3. Marks the correction as applied in subtask.result.correction

    Returns:
        {"message": "Correction applied", "subtask_id": int}
    """
    from sqlalchemy.orm.attributes import flag_modified

    # Get the subtask
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.role == SubtaskRole.ASSISTANT,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Verify user has access to the task
    task = (
        db.query(Kind)
        .filter(
            Kind.id == subtask.task_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if not task:
        # Check if user is a group chat member
        from app.models.task_member import MemberStatus, TaskMember

        member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == subtask.task_id,
                TaskMember.user_id == current_user.id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=403, detail="Access denied")

    # Update subtask.result.value with the improved answer
    subtask_result = subtask.result or {}
    if not isinstance(subtask_result, dict):
        subtask_result = {}

    # Store the original value before replacement (for potential undo)
    original_value = subtask_result.get("value", "")

    # Update the value with improved answer
    subtask_result["value"] = request.improved_answer

    # Mark correction as applied and store original value
    if "correction" in subtask_result:
        subtask_result["correction"]["applied"] = True
        subtask_result["correction"]["applied_at"] = datetime.utcnow().isoformat() + "Z"
        subtask_result["correction"]["original_value"] = original_value

    subtask.result = subtask_result
    flag_modified(subtask, "result")
    db.commit()

    logger.info(f"Applied correction for subtask {subtask_id}")

    return {"message": "Correction applied", "subtask_id": subtask_id}
