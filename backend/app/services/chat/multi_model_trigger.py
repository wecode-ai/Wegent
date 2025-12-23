# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Multi-Model Comparison Trigger Service.

This module handles triggering concurrent AI responses from multiple models
for comparison purposes. It allows users to compare responses from 2-4
different models simultaneously.
"""

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.api.ws.events import ServerEvents
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.kind import Bot, Shell, Task, Team
from app.services.chat.chat_service import chat_service
from app.services.chat.model_resolver import (
    build_default_headers_with_placeholders,
    get_bot_system_prompt,
    get_model_config_for_bot,
)
from app.services.chat.session_manager import session_manager
from app.services.chat.ws_emitter import get_ws_emitter

logger = logging.getLogger(__name__)


async def trigger_multi_model_response(
    task: Kind,
    user_subtask: Subtask,
    assistant_subtasks: List[Subtask],
    team: Kind,
    user: User,
    message: str,
    payload: Any,
    task_room: str,
    compare_group_id: str,
    namespace: Any,  # ChatNamespace instance
) -> None:
    """
    Trigger concurrent AI responses from multiple models.

    Args:
        task: Task Kind object
        user_subtask: User's message subtask
        assistant_subtasks: List of assistant subtasks (one per model)
        team: Team Kind object
        user: User object
        message: User message
        payload: Original compare send payload (ChatCompareSendPayload)
        task_room: Task room name for WebSocket events
        compare_group_id: Unique ID for this comparison group
        namespace: ChatNamespace instance for emitting events
    """
    logger.info(
        f"[multi_model] Triggering {len(assistant_subtasks)} model responses: "
        f"task_id={task.id}, compare_group_id={compare_group_id}"
    )

    # Build models info for chat:compare_start event
    models_info = []
    for subtask in assistant_subtasks:
        models_info.append(
            {
                "model_name": subtask.model_name,
                "model_display_name": subtask.model_display_name,
                "subtask_id": subtask.id,
            }
        )

    # Emit chat:compare_start event
    await namespace.emit(
        ServerEvents.CHAT_COMPARE_START,
        {
            "task_id": task.id,
            "compare_group_id": compare_group_id,
            "models": models_info,
        },
        room=task_room,
    )

    # Extract data from ORM objects before starting background tasks
    team_data = {
        "id": team.id,
        "user_id": team.user_id,
        "json": team.json,
    }
    user_data = {
        "id": user.id,
        "user_name": user.user_name,
    }

    # Create a shared completion tracking state
    completion_tracker = CompletionTracker(
        len(assistant_subtasks), compare_group_id, task.id
    )

    # Start streaming tasks concurrently for all models
    streaming_tasks = []
    for subtask in assistant_subtasks:
        model_config_override = {
            "name": subtask.model_name,
            "display_name": subtask.model_display_name,
        }

        stream_task = asyncio.create_task(
            _stream_model_response(
                task_id=task.id,
                subtask=subtask,
                team_data=team_data,
                user_data=user_data,
                message=message,
                payload=payload,
                model_config_override=model_config_override,
                compare_group_id=compare_group_id,
                completion_tracker=completion_tracker,
                namespace=namespace,
            )
        )
        streaming_tasks.append(stream_task)
        namespace._active_streams[subtask.id] = stream_task

    logger.info(f"[multi_model] Started {len(streaming_tasks)} concurrent stream tasks")


class CompletionTracker:
    """Tracks completion of multiple model responses."""

    def __init__(self, total_models: int, compare_group_id: str, task_id: int):
        self.total_models = total_models
        self.completed_count = 0
        self.compare_group_id = compare_group_id
        self.task_id = task_id
        self._lock = asyncio.Lock()

    async def mark_completed(self, namespace: Any, task_room: str) -> bool:
        """
        Mark a model as completed. Returns True if all models are done.
        """
        async with self._lock:
            self.completed_count += 1
            all_done = self.completed_count >= self.total_models

            if all_done:
                # Get message_id from the first assistant subtask
                db = SessionLocal()
                try:
                    subtask = (
                        db.query(Subtask)
                        .filter(
                            Subtask.task_id == self.task_id,
                            Subtask.compare_group_id == self.compare_group_id,
                            Subtask.role == SubtaskRole.ASSISTANT,
                        )
                        .first()
                    )
                    message_id = subtask.message_id if subtask else None
                finally:
                    db.close()

                # Emit chat:compare_all_done event
                await namespace.emit(
                    ServerEvents.CHAT_COMPARE_ALL_DONE,
                    {
                        "task_id": self.task_id,
                        "compare_group_id": self.compare_group_id,
                        "message_id": message_id,
                    },
                    room=task_room,
                )
                logger.info(
                    f"[multi_model] All models completed: "
                    f"compare_group_id={self.compare_group_id}"
                )

            return all_done


async def _stream_model_response(
    task_id: int,
    subtask: Subtask,
    team_data: Dict[str, Any],
    user_data: Dict[str, Any],
    message: str,
    payload: Any,
    model_config_override: Dict[str, str],
    compare_group_id: str,
    completion_tracker: CompletionTracker,
    namespace: Any,
):
    """
    Stream response from a single model.
    """
    db = SessionLocal()
    task_room = f"task:{task_id}"
    offset = 0
    full_response = ""
    subtask_id = subtask.id
    model_name = model_config_override["name"]

    try:
        # Get first bot for system prompt
        team_crd = Team.model_validate(team_data["json"])
        first_member = team_crd.spec.members[0]

        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team_data["user_id"],
                Kind.kind == "Bot",
                Kind.name == first_member.botRef.name,
                Kind.namespace == first_member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            error_msg = "Bot not found"
            logger.error(
                f"[multi_model] {error_msg}: task_id={task_id}, subtask_id={subtask_id}"
            )
            await namespace.emit(
                ServerEvents.CHAT_COMPARE_ERROR,
                {
                    "subtask_id": subtask_id,
                    "compare_group_id": compare_group_id,
                    "model_name": model_name,
                    "error": error_msg,
                },
                room=task_room,
            )
            await completion_tracker.mark_completed(namespace, task_room)
            return

        # Get model config with override
        model_config = get_model_config_for_bot(
            db,
            bot,
            team_data["user_id"],
            override_model_name=model_name,
            force_override=True,
        )

        # Get system prompt
        system_prompt = get_bot_system_prompt(
            db, bot, team_data["user_id"], first_member.prompt
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

        # Prepare tools
        all_tools = []
        if payload.enable_web_search and settings.WEB_SEARCH_ENABLED:
            from app.services.chat.tools import get_web_search_tool

            web_search_tool = get_web_search_tool(engine_name=payload.search_engine)
            if web_search_tool:
                all_tools.append(web_search_tool)

        # Initialize tool handler if we have any tools
        from app.services.chat.tool_handler import ToolHandler

        tool_handler = ToolHandler(all_tools) if all_tools else None

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

        # Register stream for cancellation
        cancel_event = await session_manager.register_stream(subtask_id)

        # Update status to RUNNING
        from app.services.chat.db_handler import db_handler

        await db_handler.update_subtask_status(subtask_id, "RUNNING")

        # Get streaming response from chat service
        from app.services.chat.base import get_http_client
        from app.services.chat.message_builder import message_builder
        from app.services.chat.providers import get_provider
        from app.services.chat.providers.base import ChunkType

        # Get history from Redis
        history = await session_manager.get_chat_history(task_id)
        messages = message_builder.build_messages(history, final_message, system_prompt)

        client = await get_http_client()
        provider = get_provider(model_config, client)

        if not provider:
            error_msg = "Failed to create provider"
            logger.error(
                f"[multi_model] {error_msg}: task_id={task_id}, subtask_id={subtask_id}"
            )
            await namespace.emit(
                ServerEvents.CHAT_COMPARE_ERROR,
                {
                    "subtask_id": subtask_id,
                    "compare_group_id": compare_group_id,
                    "model_name": model_name,
                    "error": error_msg,
                },
                room=task_room,
            )
            await completion_tracker.mark_completed(namespace, task_room)
            return

        # Stream response
        last_redis_save = asyncio.get_event_loop().time()
        last_db_save = asyncio.get_event_loop().time()
        redis_save_interval = settings.STREAMING_REDIS_SAVE_INTERVAL
        db_save_interval = settings.STREAMING_DB_SAVE_INTERVAL

        # Use tool calling flow if tools are available
        if tool_handler and tool_handler.has_tools:
            stream_gen = chat_service._handle_tool_calling_flow(
                provider, messages, tool_handler, cancel_event
            )
        else:
            stream_gen = provider.stream_chat(messages, cancel_event, tools=None)

        async for chunk in stream_gen:
            if cancel_event.is_set() or await session_manager.is_cancelled(subtask_id):
                # Cancelled - don't emit cancelled event for multi-model
                break

            if chunk.type == ChunkType.CONTENT and chunk.content:
                full_response += chunk.content

                # Emit compare chunk (with model_name)
                await namespace.emit(
                    ServerEvents.CHAT_COMPARE_CHUNK,
                    {
                        "subtask_id": subtask_id,
                        "compare_group_id": compare_group_id,
                        "model_name": model_name,
                        "content": chunk.content,
                        "offset": offset,
                    },
                    room=task_room,
                )
                offset += len(chunk.content)

                # Save to Redis periodically
                current_time = asyncio.get_event_loop().time()
                if current_time - last_redis_save >= redis_save_interval:
                    await session_manager.save_streaming_content(
                        subtask_id, full_response
                    )
                    last_redis_save = current_time

                # Save to DB periodically
                if current_time - last_db_save >= db_save_interval:
                    await db_handler.save_partial_response(subtask_id, full_response)
                    last_db_save = current_time

            elif chunk.type == ChunkType.ERROR:
                error_msg = chunk.error or "Unknown error"
                logger.error(
                    f"[multi_model] Stream error: task_id={task_id}, "
                    f"subtask_id={subtask_id}, model={model_name}, error={error_msg}"
                )
                await namespace.emit(
                    ServerEvents.CHAT_COMPARE_ERROR,
                    {
                        "subtask_id": subtask_id,
                        "compare_group_id": compare_group_id,
                        "model_name": model_name,
                        "error": error_msg,
                    },
                    room=task_room,
                )
                await db_handler.update_subtask_status(
                    subtask_id, "FAILED", error=chunk.error
                )
                await completion_tracker.mark_completed(namespace, task_room)
                return

        # Stream completed
        if not cancel_event.is_set():
            result = {"value": full_response}

            # Save to Redis and DB
            await session_manager.save_streaming_content(subtask_id, full_response)

            # Update subtask to completed
            await db_handler.update_subtask_status(
                subtask_id, "COMPLETED", result={"value": full_response}
            )

            # Emit compare done (for this model)
            await namespace.emit(
                ServerEvents.CHAT_COMPARE_DONE,
                {
                    "subtask_id": subtask_id,
                    "compare_group_id": compare_group_id,
                    "model_name": model_name,
                    "offset": offset,
                    "result": result,
                },
                room=task_room,
            )

            logger.info(
                f"[multi_model] Model response completed: "
                f"model={model_name}, subtask_id={subtask_id}"
            )

        # Mark this model as completed
        await completion_tracker.mark_completed(namespace, task_room)

    except Exception as e:
        logger.exception(
            f"[multi_model] Stream error: subtask={subtask_id}, model={model_name}: {e}"
        )
        await namespace.emit(
            ServerEvents.CHAT_COMPARE_ERROR,
            {
                "subtask_id": subtask_id,
                "compare_group_id": compare_group_id,
                "model_name": model_name,
                "error": str(e),
            },
            room=task_room,
        )
        await completion_tracker.mark_completed(namespace, task_room)

    finally:
        # Cleanup
        await session_manager.unregister_stream(subtask_id)
        await session_manager.delete_streaming_content(subtask_id)
        if subtask_id in namespace._active_streams:
            del namespace._active_streams[subtask_id]
        db.close()


async def select_best_response(
    task_id: int,
    compare_group_id: str,
    selected_subtask_id: int,
    user_id: int,
) -> Dict[str, Any]:
    """
    Select the best response from a multi-model comparison.

    This marks the selected response as the chosen one and updates
    the task history to use this response.

    Args:
        task_id: Task ID
        compare_group_id: Comparison group ID
        selected_subtask_id: ID of the selected subtask
        user_id: User making the selection

    Returns:
        Dict with success status and selected model info
    """
    db = SessionLocal()
    try:
        # Get all subtasks in this comparison group
        subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.compare_group_id == compare_group_id,
                Subtask.role == SubtaskRole.ASSISTANT,
            )
            .all()
        )

        if not subtasks:
            return {"error": "Comparison group not found"}

        # Mark the selected one
        selected_subtask = None
        for subtask in subtasks:
            if subtask.id == selected_subtask_id:
                subtask.is_selected_response = True
                selected_subtask = subtask
            else:
                subtask.is_selected_response = False

        if not selected_subtask:
            return {"error": "Selected subtask not found"}

        db.commit()

        # Save the selected response to chat history
        # This ensures future messages use the selected response as context
        if selected_subtask.result and selected_subtask.result.get("value"):
            # Get the user's message for this comparison
            user_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == task_id,
                    Subtask.compare_group_id == compare_group_id,
                    Subtask.role == SubtaskRole.USER,
                )
                .first()
            )

            if user_subtask and user_subtask.prompt:
                await session_manager.append_user_and_assistant_messages(
                    task_id,
                    user_subtask.prompt,
                    selected_subtask.result.get("value", ""),
                )

        return {
            "success": True,
            "selected_subtask_id": selected_subtask_id,
            "model_name": selected_subtask.model_name,
        }

    except Exception as e:
        logger.exception(f"[multi_model] Error selecting response: {e}")
        db.rollback()
        return {"error": str(e)}
    finally:
        db.close()
