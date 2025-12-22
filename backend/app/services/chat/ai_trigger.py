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

Now uses LangGraphChatService for direct chat streaming.
"""

import asyncio
import logging
from typing import Any

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.user import User
from app.schemas.kind import Team

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
    Trigger direct chat (Chat Shell) AI response using LangGraphChatService.

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
        },
        room=task_room,
    )
    logger.info("[ai_trigger] chat:start emitted")

    # Extract data from ORM objects before starting background task
    # This prevents DetachedInstanceError
    team_data = {
        "id": team.id,
        "user_id": team.user_id,
        "json": team.json,
    }
    user_data = {
        "id": user.id,
        "user_name": user.user_name,
    }

    # Start streaming in background task using LangGraphChatService
    logger.info("[ai_trigger] Starting background stream task with LangGraph")
    stream_task = asyncio.create_task(
        _stream_chat_response_langgraph(
            task_id=task.id,
            subtask_id=assistant_subtask.id,
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


async def _stream_chat_response_langgraph(
    task_id: int,
    subtask_id: int,
    team_data: dict[str, Any],
    user_data: dict[str, Any],
    message: str,
    payload: Any,
    task_room: str,
    namespace: Any,
) -> None:
    """
    Stream chat response using LangGraphChatService.

    This replaces the original _stream_chat_response with LangGraph-based implementation.
    """
    from app.api.ws.events import ServerEvents
    from app.services.chat.model_resolver import (
        build_default_headers_with_placeholders,
        get_bot_system_prompt,
        get_model_config_for_bot,
    )
    from app.services.langgraph_chat.service import (
        WebSocketStreamConfig,
        langgraph_chat_service,
    )

    db = SessionLocal()

    try:
        # Get first bot for model config
        team_crd = Team.model_validate(team_data["json"])
        first_member = team_crd.spec.members[0]

        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team_data["user_id"],
                Kind.kind == "Bot",
                Kind.name == first_member.botRef.name,
                Kind.namespace == first_member.botRef.namespace,
                Kind.is_active,
            )
            .first()
        )

        if not bot:
            await namespace.emit(
                ServerEvents.CHAT_ERROR,
                {"subtask_id": subtask_id, "error": "Bot not found"},
                room=task_room,
            )
            return

        # Get model config
        model_config = get_model_config_for_bot(
            db,
            bot,
            team_data["user_id"],
            override_model_name=payload.force_override_bot_model,
            force_override=payload.force_override_bot_model is not None,
        )

        # Get system prompt
        system_prompt = get_bot_system_prompt(
            db, bot, team_data["user_id"], first_member.prompt
        )

        # Append clarification mode instructions if enabled
        from app.services.chat.clarification_prompt import append_clarification_prompt

        system_prompt = append_clarification_prompt(
            system_prompt, payload.enable_clarification
        )

        # Handle attachment
        final_message = message
        if payload.attachment_id:
            from app.models.subtask_attachment import AttachmentStatus
            from app.services.attachment import attachment_service

            attachment = attachment_service.get_attachment(
                db=db,
                attachment_id=payload.attachment_id,
                user_id=user_data["id"],
            )

            if attachment and attachment.status == AttachmentStatus.READY:
                final_message = attachment_service.build_message_with_attachment(
                    message, attachment
                )

        # Build data sources for placeholder replacement
        bot_spec = bot.json.get("spec", {}) if bot.json else {}
        agent_config = bot_spec.get("agent_config", {})
        user_info = {"id": user_data["id"], "name": user_data["user_name"]}
        task_data_dict = {
            "task_id": task_id,
            "team_id": team_data["id"],
            "user": user_info,
            "prompt": message,
        }
        data_sources = {
            "agent_config": agent_config,
            "model_config": model_config,
            "task_data": task_data_dict,
            "user": user_info,
        }

        # Process headers
        raw_default_headers = model_config.get("default_headers", {})
        if raw_default_headers:
            processed_headers = build_default_headers_with_placeholders(
                raw_default_headers, data_sources
            )
            model_config["default_headers"] = processed_headers

        # Create WebSocket stream config
        ws_config = WebSocketStreamConfig(
            task_id=task_id,
            subtask_id=subtask_id,
            task_room=task_room,
            user_id=user_data["id"],
            user_name=user_data["user_name"],
            is_group_chat=payload.is_group_chat,
            enable_web_search=payload.enable_web_search,
            search_engine=payload.search_engine,
        )

        # Use LangGraphChatService for streaming
        await langgraph_chat_service.stream_to_websocket(
            message=final_message,
            model_config=model_config,
            system_prompt=system_prompt,
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
