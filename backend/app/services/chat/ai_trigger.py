# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Trigger Service.

This module handles triggering AI responses for chat messages.
It decouples the AI response logic from message saving, allowing for:
- Different AI backends (direct chat, executor, queue-based)
- Future extensibility (e.g., queue-based processing)
- Clean separation of concerns

Now uses ChatService with ChatConfigBuilder for direct chat streaming.
"""

import asyncio
import logging
from typing import Any

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.user import User

logger = logging.getLogger(__name__)


async def trigger_ai_response(
    task: Kind,
    assistant_subtask: Subtask,
    team: Kind,
    user: User,
    message: str,
    payload: Any,
    task_room: str,
    supports_direct_chat: bool,
    namespace: Any,  # ChatNamespace instance for emitting events
) -> None:
    """
    Trigger AI response for a chat message.

    This function handles the AI response triggering logic, decoupled from
    message saving. It supports both direct chat (Chat Shell) and executor-based
    (ClaudeCode, Agno, etc.) AI responses.

    For direct chat:
    - Emits chat:start event
    - Starts streaming in background task

    For executor-based:
    - AI response is handled by executor_manager (no action needed here)

    Args:
        task: Task Kind object
        assistant_subtask: Assistant subtask for AI response
        team: Team Kind object
        user: User object
        message: User message
        payload: Original chat send payload
        task_room: Task room name for WebSocket events
        supports_direct_chat: Whether team supports direct chat
        namespace: ChatNamespace instance for emitting events
    """
    logger.info(
        "[ai_trigger] Triggering AI response: task_id=%d, "
        "subtask_id=%d, supports_direct_chat=%s",
        task.id,
        assistant_subtask.id,
        supports_direct_chat,
    )

    if supports_direct_chat:
        # Direct chat (Chat Shell) - handle streaming locally
        await _trigger_direct_chat(
            task=task,
            assistant_subtask=assistant_subtask,
            team=team,
            user=user,
            message=message,
            payload=payload,
            task_room=task_room,
            namespace=namespace,
        )
    else:
        # Executor-based (ClaudeCode, Agno, etc.)
        # AI response is handled by executor_manager
        # The executor_manager polls for PENDING tasks and processes them
        logger.info(
            "[ai_trigger] Non-direct chat, AI response handled by executor_manager"
        )


async def _trigger_direct_chat(
    task: Kind,
    assistant_subtask: Subtask,
    team: Kind,
    user: User,
    message: str,
    payload: Any,
    task_room: str,
    namespace: Any,
) -> None:
    """
    Trigger direct chat (Chat Shell) AI response using ChatService.

    Emits chat:start event and starts streaming in background task.
    """
    from app.api.ws.events import ServerEvents

    # Emit chat:start event
    logger.info("[ai_trigger] Emitting chat:start event")
    await namespace.emit(
        ServerEvents.CHAT_START,
        {
            "task_id": task.id,
            "subtask_id": assistant_subtask.id,
            "message_id": assistant_subtask.message_id,
        },
        room=task_room,
    )
    logger.info("[ai_trigger] chat:start emitted")

    # Extract data from ORM objects before starting background task
    # This prevents DetachedInstanceError
    task_data = {
        "id": task.id,
    }
    team_data = {
        "id": team.id,
        "user_id": team.user_id,
        "name": team.name,
        "json": team.json,
    }
    user_data = {
        "id": user.id,
        "user_name": user.user_name,
    }

    # Start streaming in background task using ChatService
    logger.info("[ai_trigger] Starting background stream task with ChatService")
    stream_task = asyncio.create_task(
        _stream_chat_response(
            task_data=task_data,
            subtask_id=assistant_subtask.id,
            message_id=assistant_subtask.message_id,
            team_data=team_data,
            user_data=user_data,
            message=message,
            payload=payload,
            task_room=task_room,
            namespace=namespace,
        )
    )
    namespace._active_streams[assistant_subtask.id] = stream_task
    logger.info("[ai_trigger] Background stream task started")


async def _stream_chat_response(
    task_data: dict[str, Any],
    subtask_id: int,
    message_id: int,
    team_data: dict[str, Any],
    user_data: dict[str, Any],
    message: str,
    payload: Any,
    task_room: str,
    namespace: Any,
) -> None:
    """
    Stream chat response using ChatService.

    Uses ChatConfigBuilder to prepare configuration and delegates
    streaming to ChatService.stream_to_websocket().
    """
    from app.api.ws.events import ServerEvents
    from app.services.chat.config import ChatConfigBuilder
    from app.services.chat.service import (
        WebSocketStreamConfig,
        chat_service,
    )

    db = SessionLocal()

    try:
        # Get team Kind object from database
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_data["id"],
                Kind.kind == "Team",
                Kind.is_active,
            )
            .first()
        )

        if not team:
            await namespace.emit(
                ServerEvents.CHAT_ERROR,
                {"subtask_id": subtask_id, "error": "Team not found"},
                room=task_room,
            )
            return

        # Use ChatConfigBuilder to prepare configuration
        config_builder = ChatConfigBuilder(
            db=db,
            team=team,
            user_id=user_data["id"],
            user_name=user_data["user_name"],
        )

        try:
            chat_config = config_builder.build(
                override_model_name=payload.force_override_bot_model,
                force_override=payload.force_override_bot_model is not None,
                enable_clarification=payload.enable_clarification,
                task_id=task_data["id"],
            )
        except ValueError as e:
            await namespace.emit(
                ServerEvents.CHAT_ERROR,
                {"subtask_id": subtask_id, "error": str(e)},
                room=task_room,
            )
            return

        # Handle attachment
        final_message = message
        if payload.attachment_id:
            final_message = await _process_attachment(
                db, payload.attachment_id, user_data["id"], message
            )

        # Create WebSocket stream config
        ws_config = WebSocketStreamConfig(
            task_id=task_data["id"],
            subtask_id=subtask_id,
            task_room=task_room,
            user_id=user_data["id"],
            user_name=user_data["user_name"],
            is_group_chat=payload.is_group_chat,
            enable_web_search=payload.enable_web_search,
            search_engine=payload.search_engine,
            message_id=message_id,
        )

        # Use ChatService for streaming
        await chat_service.stream_to_websocket(
            message=final_message,
            model_config=chat_config.model_config,
            system_prompt=chat_config.system_prompt,
            config=ws_config,
            namespace=namespace,
        )

    except Exception as e:
        logger.exception("[ai_trigger] Stream error subtask=%d: %s", subtask_id, e)
        await namespace.emit(
            ServerEvents.CHAT_ERROR,
            {"subtask_id": subtask_id, "error": str(e)},
            room=task_room,
        )
    finally:
        db.close()


async def _process_attachment(
    db: Any,
    attachment_id: int,
    user_id: int,
    message: str,
) -> str:
    """
    Process attachment and build message with attachment content.

    Args:
        db: Database session
        attachment_id: Attachment ID
        user_id: User ID
        message: Original message

    Returns:
        Message with attachment content prepended if applicable
    """
    from app.models.subtask_attachment import AttachmentStatus
    from app.services.attachment import attachment_service

    attachment = attachment_service.get_attachment(
        db=db,
        attachment_id=attachment_id,
        user_id=user_id,
    )

    if attachment and attachment.status == AttachmentStatus.READY:
        return attachment_service.build_message_with_attachment(message, attachment)

    return message
