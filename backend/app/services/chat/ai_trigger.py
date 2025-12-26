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
"""

import asyncio
import logging
from typing import Any, Dict, Optional

from shared.telemetry.context import (
    SpanManager,
    SpanNames,
    TelemetryEventNames,
    attach_otel_context,
    copy_context_vars,
    detach_otel_context,
    restore_context_vars,
)

from app.api.ws.events import ServerEvents
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask
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
        f"[ai_trigger] Triggering AI response: task_id={task.id}, "
        f"subtask_id={assistant_subtask.id}, supports_direct_chat={supports_direct_chat}"
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
            f"[ai_trigger] Non-direct chat, AI response handled by executor_manager"
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
    Trigger direct chat (Chat Shell) AI response.

    Emits chat:start event and starts streaming in background task.
    """
    from app.api.ws.events import ServerEvents

    # Emit chat:start event using global emitter for cross-worker broadcasting
    logger.info(f"[ai_trigger] Emitting chat:start event")
    emitter = get_ws_emitter()
    await emitter.emit_chat_start(
        task_id=task.id,
        subtask_id=assistant_subtask.id,
    )
    logger.info(f"[ai_trigger] chat:start emitted")

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

    # Copy ContextVars (request_id, user_id, etc.) AND trace context before starting background task
    # This ensures logging context and trace parent-child relationships are preserved in the background task
    trace_context = None
    otel_context = None
    try:
        if settings.OTEL_ENABLED:
            from opentelemetry import context

            trace_context = copy_context_vars()
            # Also copy OpenTelemetry context for parent-child span relationships
            otel_context = context.get_current()
    except Exception as e:
        logger.debug(f"Failed to copy trace context: {e}")

    # Start streaming in background task
    logger.info(f"[ai_trigger] Starting background stream task")
    stream_task = asyncio.create_task(
        _stream_chat_response(
            task_id=task.id,
            subtask_id=assistant_subtask.id,
            team_data=team_data,
            user_data=user_data,
            message=message,
            payload=payload,
            namespace=namespace,
            trace_context=trace_context,
            otel_context=otel_context,
        )
    )
    namespace._active_streams[assistant_subtask.id] = stream_task
    namespace._stream_versions[assistant_subtask.id] = "v1"
    logger.info(f"[ai_trigger] Background stream task started")


async def _stream_chat_response(
    task_id: int,
    subtask_id: int,
    team_data: Dict[str, Any],
    user_data: Dict[str, Any],
    message: str,
    payload: Any,
    namespace: Any,
    trace_context: Optional[Dict[str, Any]] = None,
    otel_context: Optional[Any] = None,
):
    """
    Stream chat response to task room.

    Args:
        trace_context: Trace context copied from parent task (for logging context)
        otel_context: OpenTelemetry context from parent (for parent-child span relationships)
    """
    # Restore trace context at the start of background task
    # This ensures logging uses the correct request_id and user context
    if trace_context:
        try:
            restore_context_vars(trace_context)
            logger.debug(
                f"[ai_trigger] Restored trace context: request_id={trace_context.get('request_id')}"
            )
        except Exception as e:
            logger.debug(f"Failed to restore trace context: {e}")

    # Restore OpenTelemetry context to maintain parent-child span relationships
    otel_token = attach_otel_context(otel_context) if otel_context else None

    # Create OpenTelemetry span manager for this streaming operation
    span_manager = SpanManager(SpanNames.CHAT_STREAM_RESPONSE)
    span_manager.create_span()
    span_manager.enter_span()

    db = SessionLocal()
    task_room = f"task:{task_id}"
    offset = 0
    full_response = ""
    mcp_session = None  # Initialize for cleanup in finally block

    # Get subtask message_id for error events
    subtask_message_id = None
    try:
        subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
        if subtask:
            subtask_message_id = subtask.message_id
    except Exception as e:
        logger.warning(f"Failed to get subtask message_id: {e}")

    try:
        # Set base attributes (user and task info)
        span_manager.set_base_attributes(
            task_id=task_id,
            subtask_id=subtask_id,
            user_id=str(user_data["id"]),
            user_name=user_data["user_name"],
        )

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
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            error_msg = "Bot not found"
            logger.error(
                f"[ai_trigger] {error_msg}: task_id={task_id}, subtask_id={subtask_id}"
            )

            # Record error in span
            span_manager.record_error(TelemetryEventNames.BOT_NOT_FOUND, error_msg)

            emitter = get_ws_emitter()
            await emitter.emit_chat_error(
                task_id=task_id,
                subtask_id=subtask_id,
                error=error_msg,
                message_id=subtask_message_id,
            )

            # IMPORTANT: Also emit chat:done to signal stream completion
            # This ensures frontend knows the stream has ended, even though it failed
            await emitter.emit_chat_done(
                task_id=task_id,
                subtask_id=subtask_id,
                offset=0,
                result={"value": "", "error": error_msg},
                message_id=subtask_message_id,
            )
            logger.info(
                f"[ai_trigger] Emitted chat:error and chat:done for bot not found: "
                f"task={task_id} subtask={subtask_id}"
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

        # Handle attachments (supports both single and multiple)
        # Convert single attachment_id to list for unified processing
        attachment_ids_to_process = []
        if payload.attachment_ids:
            attachment_ids_to_process = payload.attachment_ids
        elif payload.attachment_id:
            # Backward compatibility: convert single attachment_id to list
            attachment_ids_to_process = [payload.attachment_id]

        final_message = message
        if attachment_ids_to_process:
            final_message = await _process_attachments(
                db, attachment_ids_to_process, user_data["id"], message
            )

        # Prepare tools
        all_tools = []
        if payload.enable_web_search and settings.WEB_SEARCH_ENABLED:
            from app.services.chat.tools import get_web_search_tool

            # Pass the search engine selected by user
            web_search_tool = get_web_search_tool(engine_name=payload.search_engine)
            if web_search_tool:
                all_tools.append(web_search_tool)
        # Load MCP tools if enabled
        from app.services.chat.tools import get_mcp_session

        mcp_session = await get_mcp_session(task_id)
        if mcp_session:
            all_tools.extend(mcp_session.get_tools())

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

        # Add model info to span for all requests (success and error)
        span_manager.set_model_attributes(model_config)

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

        # Get global emitter
        emitter = get_ws_emitter()

        # Check if this is a group chat - get history from database with user names
        is_group_chat = payload.is_group_chat
        if is_group_chat:
            logger.info(
                f"[ai_trigger] Getting group chat history for task_id={task_id}"
            )
            history = await chat_service._get_group_chat_history(task_id)
            logger.info(
                f"[ai_trigger] Got group chat history: count={len(history)}, "
                f"roles={[m.get('role') for m in history]}"
            )
            # Apply truncation for group chat
            history = chat_service._truncate_group_chat_history(history, task_id)
            logger.info(f"[ai_trigger] After truncation: count={len(history)}")
        else:
            # For regular chat, get history from Redis
            history = await session_manager.get_chat_history(task_id)

        messages = message_builder.build_messages(history, final_message, system_prompt)
        logger.info(
            f"[ai_trigger] Built messages: total={len(messages)}, "
            f"roles={[m.get('role') for m in messages]}"
        )

        client = await get_http_client()
        provider = get_provider(model_config, client)

        if not provider:
            error_msg = "Failed to create provider"
            logger.error(
                f"[ai_trigger] {error_msg}: task_id={task_id}, subtask_id={subtask_id}, model_config={model_config}"
            )

            # Record error in span
            span_manager.record_error(
                TelemetryEventNames.PROVIDER_CREATION_FAILED, error_msg
            )

            await emitter.emit_chat_error(
                task_id=task_id,
                subtask_id=subtask_id,
                error=error_msg,
                message_id=subtask_message_id,
            )

            # IMPORTANT: Also emit chat:done to signal stream completion
            # This ensures frontend knows the stream has ended, even though it failed
            await emitter.emit_chat_done(
                task_id=task_id,
                subtask_id=subtask_id,
                offset=0,
                result={"value": "", "error": error_msg},
                message_id=subtask_message_id,
            )
            logger.info(
                f"[ai_trigger] Emitted chat:error and chat:done for provider creation failed: "
                f"task={task_id} subtask={subtask_id}"
            )
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
                # Cancelled
                await emitter.emit_chat_cancelled(
                    task_id=task_id,
                    subtask_id=subtask_id,
                )
                break

            if chunk.type == ChunkType.CONTENT and chunk.content:
                full_response += chunk.content

                # Emit chunk
                await emitter.emit_chat_chunk(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=chunk.content,
                    offset=offset,
                )
                offset += len(chunk.content)

                # Save to Redis periodically
                current_time = asyncio.get_event_loop().time()
                if current_time - last_redis_save >= redis_save_interval:
                    await session_manager.save_streaming_content(
                        subtask_id, full_response
                    )
                    await session_manager.publish_streaming_chunk(
                        subtask_id, chunk.content
                    )
                    last_redis_save = current_time

                # Save to DB periodically
                if current_time - last_db_save >= db_save_interval:
                    await db_handler.save_partial_response(subtask_id, full_response)
                    last_db_save = current_time

            elif chunk.type == ChunkType.ERROR:
                error_msg = chunk.error or "Unknown error"

                logger.error(
                    f"[ai_trigger] Stream chunk error: task_id={task_id}, subtask_id={subtask_id}, "
                    f"error={error_msg}"
                )

                # Record error in span with detailed context (includes model info)
                span_manager.record_error(
                    TelemetryEventNames.STREAM_CHUNK_ERROR, error_msg, model_config
                )

                await emitter.emit_chat_error(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    error=error_msg,
                    message_id=subtask_message_id,
                )
                await db_handler.update_subtask_status(
                    subtask_id, "FAILED", error=chunk.error
                )

                # IMPORTANT: Also emit chat:done to signal stream completion
                # This ensures frontend knows the stream has ended, even though it failed
                # Without this, frontend may wait indefinitely or have ordering issues
                await emitter.emit_chat_done(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    offset=offset,
                    result={"value": full_response, "error": error_msg},
                    message_id=subtask_message_id,
                )
                logger.info(
                    f"[ai_trigger] Emitted chat:error and chat:done for failed stream: "
                    f"task={task_id} subtask={subtask_id} message_id={subtask_message_id}"
                )
                return

        # Stream completed
        if not cancel_event.is_set():
            result = {"value": full_response}

            # Save to Redis and DB FIRST before emitting done event
            await session_manager.save_streaming_content(subtask_id, full_response)
            await session_manager.publish_streaming_done(subtask_id, result)

            # Save chat history
            # Note: The message parameter might be RAG prompt, but the original message
            # is already saved in user_subtask.prompt, so this is fine for Redis history
            await session_manager.append_user_and_assistant_messages(
                task_id, message, full_response
            )

            # Update subtask to completed
            await db_handler.update_subtask_status(
                subtask_id, "COMPLETED", result={"value": full_response}
            )

            # Get message_id from database for proper message ordering
            subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
            message_id = subtask.message_id if subtask else None

            # Emit done event AFTER database is updated
            # Use ws_emitter for consistent handling with message_id
            ws_emitter = get_ws_emitter()
            if ws_emitter:
                await ws_emitter.emit_chat_done(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    offset=offset,
                    result=result,
                    message_id=message_id,
                )

                # Also notify user room for multi-device sync
                await ws_emitter.emit_chat_bot_complete(
                    user_id=user_data["id"],
                    task_id=task_id,
                    subtask_id=subtask_id,
                    content=full_response,
                    result=result,
                )

            # Mark span as successful
            span_manager.record_success(
                response_length=len(full_response),
                response_chunks=offset,
                event_name=TelemetryEventNames.STREAM_COMPLETED,
            )

    except Exception as e:
        logger.exception(f"[ai_trigger] Stream error subtask={subtask_id}: {e}")

        # Record error in span
        span_manager.record_exception(e)

        # Use global emitter for cross-worker broadcasting
        error_emitter = get_ws_emitter()
        await error_emitter.emit_chat_error(
            task_id=task_id,
            subtask_id=subtask_id,
            error=str(e),
            message_id=subtask_message_id,
        )

        # IMPORTANT: Also emit chat:done to signal stream completion
        # This ensures frontend knows the stream has ended, even though it failed
        # Without this, frontend may wait indefinitely or have ordering issues
        await error_emitter.emit_chat_done(
            task_id=task_id,
            subtask_id=subtask_id,
            offset=0,  # No content was streamed
            result={"value": "", "error": str(e)},
            message_id=subtask_message_id,
        )
        logger.info(
            f"[ai_trigger] Emitted chat:error and chat:done for exception: "
            f"task={task_id} subtask={subtask_id} message_id={subtask_message_id}"
        )
    finally:
        # Detach OTEL context first (before exiting span)
        detach_otel_context(otel_token)

        # Exit span context
        span_manager.exit_span()

        # Cleanup
        await session_manager.unregister_stream(subtask_id)
        await session_manager.delete_streaming_content(subtask_id)
        if subtask_id in namespace._active_streams:
            del namespace._active_streams[subtask_id]
        if subtask_id in getattr(namespace, "_stream_versions", {}):
            del namespace._stream_versions[subtask_id]
        # Cleanup MCP session when stream ends
        if mcp_session:
            from app.services.chat.tools import cleanup_mcp_session

            await cleanup_mcp_session(task_id)
        db.close()


async def _process_attachments(
    db: Any,
    attachment_ids: list[int],
    user_id: int,
    message: str,
) -> str:
    """
    Process multiple attachments and build message with all attachment contents.

    Args:
        db: Database session (SQLAlchemy Session)
        attachment_ids: List of attachment IDs
        user_id: User ID
        message: Original message

    Returns:
        Message with all attachment contents prepended, or vision structure for images
    """
    from app.models.subtask_attachment import AttachmentStatus
    from app.services.attachment import attachment_service

    if not attachment_ids:
        return message

    # Collect all attachments
    text_attachments = []
    image_attachments = []

    for idx, attachment_id in enumerate(attachment_ids, start=1):
        attachment = attachment_service.get_attachment(
            db=db,
            attachment_id=attachment_id,
            user_id=user_id,
        )

        if attachment and attachment.status == AttachmentStatus.READY:
            # Separate images and text documents
            if (
                attachment_service.is_image_attachment(attachment)
                and attachment.image_base64
            ):
                image_attachments.append(
                    {
                        "image_base64": attachment.image_base64,
                        "mime_type": attachment.mime_type,
                        "filename": attachment.original_filename,
                    }
                )
            else:
                # For text documents, get the formatted content
                doc_prefix = attachment_service.build_document_text_prefix(attachment)
                if doc_prefix:
                    text_attachments.append(f"[Attachment {idx}]\n{doc_prefix}")

    # If we have images, return a multi-vision structure
    if image_attachments:
        # Build text content from text attachments
        combined_text = ""
        if text_attachments:
            combined_text = "\n".join(text_attachments) + "\n\n"
        combined_text += f"[User Question]:\n{message}"

        return {
            "type": "multi_vision",
            "text": combined_text,
            "images": image_attachments,
        }

    # If only text attachments, combine them
    if text_attachments:
        combined_attachments = "\n".join(text_attachments)
        return f"{combined_attachments}[User Question]:\n{message}"

    return message
