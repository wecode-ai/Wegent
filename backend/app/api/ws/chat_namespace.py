# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat namespace for Socket.IO.

This module implements the /chat namespace for real-time chat communication.
It handles authentication, room management, and chat events.

Business logic has been extracted to services/chat/ modules:
- access/: Authentication and permission checks
- operations/: Cancel, retry, resume operations
- rag/: RAG processing
"""

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional

import socketio
from socketio.exceptions import ConnectionRefusedError
from sqlalchemy.orm import Session

import app.stores.tasks as task_stores
from app.api.ws.connection_utils import enter_connect_room, save_connect_session
from app.api.ws.context_decorators import auto_task_context
from app.api.ws.decorators import trace_websocket_event
from app.api.ws.events import (
    ChatCancelPayload,
    ChatErrorPayload,
    ChatGuideAck,
    ChatGuidePayload,
    ChatResumePayload,
    ChatRetryPayload,
    ChatSendAck,
    ChatSendPayload,
    ClientEvents,
    GenerateParams,
    GenericAck,
    HistorySyncAck,
    HistorySyncPayload,
    ServerEvents,
    TaskJoinAck,
    TaskJoinPayload,
    TaskLeavePayload,
)
from app.core.constants import (
    CLIENT_ORIGIN_WEWORK,
    get_wework_task_room,
    get_wework_user_room,
)
from app.core.payload_codec import project_model
from app.core.web_background_tasks import web_background_task_manager
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task, Team

# Import from services/chat modules
from app.services.chat.access import (
    can_access_task,
    get_active_streaming,
    get_token_expiry,
    verify_jwt_token,
)
from app.services.chat.config import get_team_first_bot_shell_type
from app.services.chat.guidance_queue import GuidanceQueueFullError, guidance_queue
from app.services.chat.operations import (
    call_executor_cancel,
    extract_model_override_info,
    fetch_retry_context,
    reset_subtask_for_retry,
)
from app.services.chat.rag import process_context_and_rag
from app.services.chat.storage import session_manager
from app.services.chat.storage.db import get_db_session, run_sync_in_executor
from app.services.chat.task_device_resolution import (
    resolve_chat_task_device_id,
)
from app.services.chat.trigger import (
    collect_completed_result,
    persist_completed_result,
    trigger_ai_response_unified,
)
from app.services.execution.stream_client import StreamWorkerExecutionError
from app.services.execution.web_stream_client import web_stream_worker_client
from app.services.execution.web_stream_protocol import SUBTASK_RECOVERY_EXECUTE
from app.services.task_fork_history import task_fork_history_resolver
from app.utils.client_payload_sanitizer import sanitize_client_payload
from app.utils.prompt_utils import extract_display_prompt
from shared.telemetry.context import (
    set_request_context,
    set_user_context,
)

logger = logging.getLogger(__name__)


async def _load_subtask_recovery(
    subtask_id: int,
    *,
    offset: int,
    include_blocks: bool,
    include_context_metrics: bool,
) -> dict[str, Any]:
    result = await web_stream_worker_client.execute(
        SUBTASK_RECOVERY_EXECUTE,
        {
            "subtask_id": subtask_id,
            "offset": offset,
            "include_blocks": include_blocks,
            "include_context_metrics": include_context_metrics,
        },
    )
    content = result.get("content")
    cursor = result.get("cursor")
    blocks = result.get("blocks", [])
    context_metrics = result.get("context_metrics")
    if (
        not isinstance(content, str)
        or not isinstance(cursor, int)
        or cursor < 0
        or not isinstance(blocks, list)
        or (context_metrics is not None and not isinstance(context_metrics, dict))
    ):
        raise StreamWorkerExecutionError(
            "Stream worker returned an invalid recovery snapshot"
        )
    return {
        "content": content,
        "cursor": cursor,
        "blocks": blocks,
        "context_metrics": context_metrics,
    }


@dataclass(frozen=True)
class _AuthenticatedSocketUser:
    """Authentication data safe to use after the worker session is closed."""

    user_id: int
    user_name: str
    token_exp: Optional[int]


@dataclass
class _ChatSendPreparation:
    """Detached database phase for one chat send request."""

    payload: ChatSendPayload
    response: Optional[Dict[str, Any]] = None
    user: Optional[User] = None
    team: Optional[Kind] = None
    pipeline_info: Optional[Dict[str, Any]] = None
    should_trigger_ai: bool = True
    pipeline_confirm: bool = False


def _get_retry_generate_params(user_subtask: Subtask) -> Optional[GenerateParams]:
    """Restore persisted generation options when retrying the same user message."""
    result = getattr(user_subtask, "result", None)
    if not isinstance(result, dict):
        return None

    video_config = result.get("video_config")
    if isinstance(video_config, dict):
        return GenerateParams(
            model=video_config.get("model"),
            model_display_name=video_config.get("model_display_name"),
            resolution=video_config.get("resolution"),
            ratio=video_config.get("ratio"),
            duration=video_config.get("duration"),
            generation_mode_id=video_config.get("generation_mode_id"),
        )

    image_config = result.get("image_config")
    if isinstance(image_config, dict):
        return GenerateParams(size=image_config.get("size"))
    return None


def _apply_artifact_node_scope(
    *,
    db: Session,
    user: User,
    payload: ChatSendPayload,
) -> None:
    """Replace client-selected sources with the validated Artifact source scope."""
    if payload.artifact_context is None:
        return
    if payload.task_type != "knowledge" or payload.knowledge_base_id is None:
        raise ValueError("Artifact node questions require a knowledge base task")

    from app.api.ws.events import ContextItem
    from app.services.knowledge.artifact_repository import (
        KnowledgeArtifactRepository,
    )
    from app.services.knowledge.artifact_service import ArtifactService

    artifact_context = payload.artifact_context
    service = ArtifactService(
        db,
        user,
        KnowledgeArtifactRepository(db),
    )
    _, document_ids = service.resolve_mind_map_node(
        payload.knowledge_base_id,
        artifact_context.artifact_id,
        artifact_context.node_id,
    )
    knowledge_base_name = service.resolve_knowledge_base_name(payload.knowledge_base_id)

    knowledge_base_id = payload.knowledge_base_id
    payload.attachment_id = None
    payload.attachment_ids = None
    payload.contexts = [
        ContextItem(
            type="knowledge_base",
            data={
                "knowledge_id": knowledge_base_id,
                "name": knowledge_base_name,
                "document_ids": document_ids,
                "scope_restricted": True,
            },
        )
    ]


async def _finalize_failed_ai_trigger(
    *,
    task_id: int,
    assistant_subtask_id: int,
    error_message: str,
    error_code: str,
) -> None:
    """Persist a failed async AI trigger so follow-up messages are not blocked."""
    final_result = await collect_completed_result(
        assistant_subtask_id,
        status="FAILED",
        error_message=error_message,
        error_code=error_code,
    )
    await persist_completed_result(
        subtask_id=assistant_subtask_id,
        task_id=task_id,
        status="FAILED",
        result=final_result,
        error=error_message,
    )


class ChatNamespace(socketio.AsyncNamespace):
    """
    Socket.IO namespace for chat functionality.

    Handles:
    - Authentication on connect
    - Room management (user rooms, task rooms)
    - Chat message sending and streaming
    - Task events

    Note: Event names with colons (e.g., 'chat:send') are handled by
    overriding the trigger_event method to map colon-separated event names
    to their handler methods.
    """

    def __init__(self, namespace: str = "/chat"):
        """Initialize the chat namespace."""
        super().__init__(namespace)
        self._active_streams: Dict[int, asyncio.Task] = {}  # subtask_id -> stream task
        self._stream_versions: Dict[int, str] = {}  # subtask_id -> "v1" | "v2"

        # Map colon-separated event names to handler methods
        self._event_handlers: Dict[str, str] = {
            "chat:send": "on_chat_send",
            "chat:cancel": "on_chat_cancel",
            "chat:resume": "on_chat_resume",
            "chat:retry": "on_chat_retry",
            "chat:guide": "on_chat_guide",
            "task:join": "on_task_join",
            "task:leave": "on_task_leave",
            "task:close-session": "on_task_close_session",
            "history:sync": "on_history_sync",
            "skill:response": "on_skill_response",
        }

    async def _check_token_expiry(self, sid: str) -> bool:
        """
        Check if session token is expired.

        Args:
            sid: Socket ID

        Returns:
            True if token is expired, False otherwise
        """
        session = await self.get_session(sid)
        token_exp = session.get("token_exp")
        if not token_exp:
            # No expiry stored, assume expired
            return True
        return datetime.now().timestamp() > token_exp

    async def _handle_token_expired(self, sid: str) -> dict:
        """
        Handle token expiry: emit auth_error event and disconnect client.

        Args:
            sid: Socket ID

        Returns:
            Error dict to return to client
        """
        logger.warning(f"[WS] Token expired for sid={sid}, disconnecting")
        from app.api.ws.events import ServerEvents

        await self.emit(
            ServerEvents.AUTH_ERROR,
            {"error": "Token expired", "code": "TOKEN_EXPIRED"},
            to=sid,
        )
        await self.disconnect(sid)
        return {"error": "Token expired"}

    @auto_task_context(
        ChatGuidePayload, task_id_field="task_id", subtask_id_field="subtask_id"
    )
    async def on_chat_guide(self, sid: str, data: ChatGuidePayload) -> dict:
        """Handle chat:guide for Chat Shell-only runtime guidance."""
        logger.info(
            "[guidance] on_chat_guide received: sid=%s task_id=%s subtask_id=%s team_id=%s",
            sid,
            getattr(data, "task_id", None),
            getattr(data, "subtask_id", None),
            getattr(data, "team_id", None),
        )
        if await self._check_token_expiry(sid):
            return await self._handle_token_expired(sid)

        session = await self.get_session(sid)
        user_id = session.get("user_id")
        if not user_id:
            return await project_model(
                ChatGuideAck,
                {"error": "Not authenticated"},
            )

        payload = data
        if not await can_access_task(user_id, payload.task_id):
            return await project_model(
                ChatGuideAck,
                {"error": "Task not found or access denied"},
            )

        validation_error = await run_sync_in_executor(
            _validate_chat_guidance,
            payload.task_id,
            payload.subtask_id,
            payload.team_id,
        )
        if validation_error:
            return await project_model(
                ChatGuideAck,
                {"error": validation_error},
            )

        try:
            item = await guidance_queue.enqueue(
                task_id=payload.task_id,
                subtask_id=payload.subtask_id,
                team_id=payload.team_id,
                user_id=user_id,
                message=payload.message,
                guidance_id=payload.client_guidance_id,
            )
        except GuidanceQueueFullError as error:
            return await project_model(
                ChatGuideAck,
                {"error": str(error)},
            )
        logger.info(
            "[guidance] enqueued: task_id=%s subtask_id=%s guidance_id=%s",
            payload.task_id,
            payload.subtask_id,
            item.guidance_id,
        )
        item_data = item.to_dict()
        await self.emit(
            ServerEvents.CHAT_GUIDANCE_QUEUED,
            item_data,
            room=f"task:{payload.task_id}",
        )
        return await project_model(
            ChatGuideAck,
            {"guidance_id": item.guidance_id},
        )

    @trace_websocket_event(
        exclude_events={"connect"},  # connect is handled separately in on_connect
        extract_event_data=True,  # auto-extract task_id, team_id, subtask_id
    )
    async def trigger_event(self, event: str, sid: str, *args):
        """
        Override trigger_event to handle colon-separated event names.

        python-socketio's default behavior converts on_xxx methods to xxx events,
        but we need to support colon-separated event names like 'chat:send'.

        The @trace_websocket_event decorator automatically handles:
        - Generating unique request_id for each event
        - Restoring user context from session
        - Creating OpenTelemetry span with event metadata
        - Recording exceptions and span status

        Args:
            event: Event name (e.g., 'chat:send')
            sid: Socket ID
            *args: Event arguments

        Returns:
            Result from the event handler
        """
        return await self._execute_handler(event, sid, *args)

    async def _execute_handler(self, event: str, sid: str, *args):
        """Execute the event handler for the given event."""
        # Check if this is a colon-separated event we handle
        if event in self._event_handlers:
            handler_name = self._event_handlers[event]
            handler = getattr(self, handler_name, None)
            if handler:
                logger.debug(
                    f"[WS] Routing event '{event}' to handler '{handler_name}'"
                )
                return await handler(sid, *args)

        # Fall back to default behavior for other events (connect, disconnect, etc.)
        return await super().trigger_event(event, sid, *args)

    async def on_connect(self, sid: str, environ: dict, auth: Optional[dict] = None):
        """
        Handle client connection.

        Verifies JWT token and joins user to their personal room.
        Rejects new connections during graceful shutdown.

        Args:
            sid: Socket ID
            environ: WSGI environ dict
            auth: Authentication data (expected: {"token": "..."})

        Raises:
            ConnectionRefusedError: If authentication fails or server is shutting down
        """
        from app.core.shutdown import shutdown_manager

        # Generate unique request ID for this WebSocket connection
        request_id = str(uuid.uuid4())[:8]
        set_request_context(request_id)

        logger.info(f"[WS] Connection attempt sid={sid}")

        # Reject new connections during graceful shutdown
        if shutdown_manager.is_shutting_down:
            logger.warning(f"[WS] Rejecting connection during shutdown sid={sid}")
            raise ConnectionRefusedError("Server is shutting down")

        # Check auth token
        if not auth or not isinstance(auth, dict):
            logger.warning(f"[WS] Missing auth data sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        token = auth.get("token")
        if not token:
            logger.warning(f"[WS] Missing token in auth sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        # Verify token
        authenticated_user = await run_sync_in_executor(
            _authenticate_websocket_token, token
        )
        if not authenticated_user:
            logger.warning(f"[WS] Invalid token sid={sid}")
            raise ConnectionRefusedError("Invalid or expired token")
        client_origin = (
            CLIENT_ORIGIN_WEWORK
            if auth.get("client_origin") == CLIENT_ORIGIN_WEWORK
            else None
        )

        await save_connect_session(
            self,
            sid,
            session_data={
                "user_id": authenticated_user.user_id,
                "user_name": authenticated_user.user_name,
                "request_id": request_id,
                "token_exp": authenticated_user.token_exp,
                "auth_token": token,
                "client_origin": client_origin,
            },
            logger=logger,
            log_prefix="[WS]",
        )

        # Set user context for trace logging
        set_user_context(
            user_id=str(authenticated_user.user_id),
            user_name=authenticated_user.user_name,
        )

        # Join only the stream room for this client origin. Wework gets raw
        # Responses API events in a dedicated room and should not receive the
        # legacy chat:* compatibility stream.
        user_room = (
            get_wework_user_room(authenticated_user.user_id)
            if client_origin == CLIENT_ORIGIN_WEWORK
            else f"user:{authenticated_user.user_id}"
        )
        await enter_connect_room(
            self,
            sid,
            user_room,
            logger=logger,
            log_prefix="[WS]",
        )

        logger.info(
            "[WS] Connected user=%s (%s) sid=%s",
            authenticated_user.user_id,
            authenticated_user.user_name,
            sid,
        )

    async def on_disconnect(self, sid: str):
        """
        Handle client disconnection.

        Args:
            sid: Socket ID
        """
        try:
            session = await self.get_session(sid)
            user_id = session.get("user_id", "unknown")
            request_id = session.get("request_id")

            # Restore request context for trace logging
            if request_id:
                set_request_context(request_id)
            if user_id != "unknown":
                set_user_context(user_id=str(user_id))

            logger.info(f"[WS] Disconnected user={user_id} sid={sid}")
        except Exception:
            logger.info(f"[WS] Disconnected sid={sid}")

    # ============================================================
    # Task Room Events
    # ============================================================

    @auto_task_context(TaskJoinPayload)
    async def on_task_join(self, sid: str, data: dict) -> dict:
        """
        Handle task:join event.

        Joins the client to a task room and returns streaming info and subtasks.
        This allows the frontend to immediately sync messages without a separate API call.

        Supports incremental sync via after_message_id parameter:
        - If after_message_id is provided, only returns messages after that ID (for reconnect)
        - If after_message_id is None, returns all messages (for initial join)

        Args:
            sid: Socket ID
            data: {"task_id": int, "after_message_id": int?}

        Returns:
            {"streaming": {...}, "subtasks": [...]} or {"error": "..."}
        """
        payload = data  # Already validated by decorator

        logger.info(
            f"[WS] task:join received: sid={sid}, task_id={payload.task_id}, "
            f"after_message_id={payload.after_message_id}"
        )

        # Check token expiry before processing
        if await self._check_token_expiry(sid):
            return await self._handle_token_expired(sid)

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            logger.warning(f"[WS] task:join error: Not authenticated, sid={sid}")
            return {"error": "Not authenticated"}

        # Check permission
        if not await can_access_task(user_id, payload.task_id):
            logger.warning(
                f"[WS] task:join error: Access denied, user={user_id}, task={payload.task_id}"
            )
            return {"error": "Access denied"}

        # Join only the stream room for this client origin. Wework uses the
        # raw response.* stream; frontend keeps the legacy chat:* stream.
        task_room = (
            get_wework_task_room(payload.task_id)
            if session.get("client_origin") == CLIENT_ORIGIN_WEWORK
            else f"task:{payload.task_id}"
        )
        await self.enter_room(sid, task_room)

        logger.info(
            f"[WS] User {user_id} joined task room {payload.task_id} (room={task_room}, sid={sid})"
        )

        # Get subtasks for immediate message sync
        # If after_message_id is provided, only fetch messages after that ID (incremental sync)
        # Otherwise, fetch all messages (initial join)
        subtasks_dict = None
        try:
            subtasks_dict = await run_sync_in_executor(
                _fetch_subtasks_for_task_join,
                payload.task_id,
                user_id,
                payload.after_message_id,
            )
            if payload.after_message_id is not None:
                logger.info(
                    f"[WS] task:join incremental sync: fetched {len(subtasks_dict) if subtasks_dict else 0} new messages "
                    f"after message_id={payload.after_message_id} for task_id={payload.task_id}"
                )
            else:
                logger.info(
                    f"[WS] task:join full sync: fetched {len(subtasks_dict) if subtasks_dict else 0} "
                    f"subtasks for task_id={payload.task_id}"
                )
        except Exception as e:
            logger.exception(f"[WS] task:join error fetching subtasks: {e}")

        # Check for active streaming
        logger.info(
            f"[WS] task:join checking for active streaming, task_id={payload.task_id}"
        )
        streaming_info = await get_active_streaming(payload.task_id)
        logger.info(
            "[WS] task:join active streaming lookup: task_id=%s active=%s",
            payload.task_id,
            bool(streaming_info),
        )

        if streaming_info:
            subtask_id = streaming_info["subtask_id"]

            try:
                recovery = await _load_subtask_recovery(
                    subtask_id,
                    offset=0,
                    include_blocks=True,
                    include_context_metrics=True,
                )
            except RuntimeError as error:
                logger.error(
                    "[WS] task:join stream recovery failed: task_id=%s "
                    "subtask_id=%s error=%s",
                    payload.task_id,
                    subtask_id,
                    error,
                )
                return {"error": "Streaming recovery is unavailable"}
            cached_content = recovery["content"]
            blocks = recovery["blocks"]
            cached_context_metrics = recovery["context_metrics"]
            offset = recovery["cursor"]

            logger.info(
                f"[WS] task:join found active streaming: subtask_id={subtask_id}, "
                f"cached_content_len={len(cached_content) if cached_content else 0}, "
                f"blocks_count={len(blocks)}, offset={offset}"
            )

            if cached_context_metrics:
                await self.emit(
                    ServerEvents.CHAT_STATUS_UPDATED,
                    cached_context_metrics,
                    to=sid,
                )

            return {
                "streaming": {
                    "subtask_id": subtask_id,
                    "offset": offset,
                    "cached_content": cached_content or "",
                    "blocks": blocks,
                    "started_at": streaming_info.get("started_at"),
                    "last_activity_at": streaming_info.get("last_activity_at"),
                },
                "status_updated": cached_context_metrics,
                "subtasks": subtasks_dict,
            }

        logger.info(
            f"[WS] task:join no active streaming found for task_id={payload.task_id}"
        )
        return {"streaming": None, "subtasks": subtasks_dict}

    @auto_task_context(TaskLeavePayload)
    async def on_task_leave(self, sid: str, data: dict) -> dict:
        """
        Handle task:leave event.

        Args:
            sid: Socket ID
            data: {"task_id": int}

        Returns:
            {"success": true}
        """
        payload = data  # Already validated by decorator

        task_room = f"task:{payload.task_id}"
        await self.leave_room(sid, task_room)

        session = await self.get_session(sid)
        user_id = session.get("user_id", "unknown")
        logger.info(f"[WS] User {user_id} left task room {payload.task_id}")

        return {"success": True}

    # ============================================================
    # Chat Events
    # ============================================================

    @auto_task_context(ChatSendPayload, task_id_field="task_id")
    async def on_chat_send(self, sid: str, data: dict) -> dict:
        """
        Handle chat:send event.

        Creates task/subtasks and starts streaming response.
        Also handles pipeline stage confirmation when action='pipeline:confirm'.

        Args:
            sid: Socket ID
            data: ChatSendPayload fields

        Returns:
            {"task_id": int, "subtask_id": int} or {"error": "..."}
            For pipeline:confirm action: {"task_id": int, "current_stage": int, ...}
        """
        logger.info("[WS] chat:send received sid=%s", sid)

        # Check token expiry before processing
        if await self._check_token_expiry(sid):
            return await self._handle_token_expired(sid)

        payload = data  # Already validated by decorator
        logger.info(
            f"[WS] chat:send payload parsed: team_id={payload.team_id}, task_id={payload.task_id}, "
            f"message_len={len(payload.message) if payload.message else 0}, action={payload.action}"
        )

        session = await self.get_session(sid)
        effective_message = payload.message
        user_id = session.get("user_id")
        user_name = session.get("user_name")
        auth_token = session.get("auth_token", "")  # Get original JWT token
        logger.info(f"[WS] chat:send session: user_id={user_id}, user_name={user_name}")

        if not user_id:
            logger.error("[WS] chat:send error: Not authenticated")
            return {"error": "Not authenticated"}

        try:
            preparation = await run_sync_in_executor(
                _prepare_chat_send,
                user_id,
                payload,
            )
            if preparation.response is not None:
                return preparation.response
            payload = preparation.payload
            user = preparation.user
            team = preparation.team
            if user is None or team is None:
                return {"error": "Chat send preparation failed"}

            if preparation.pipeline_confirm:
                from app.services.chat.pipeline_advance import (
                    advance_pipeline_stage_and_send,
                )

                return await advance_pipeline_stage_and_send(
                    user_id=user_id,
                    team_id=team.id,
                    task_id=payload.task_id,
                    message=effective_message,
                    payload=payload,
                    skip_sid=sid,
                    auth_token=auth_token,
                )

            pipeline_info = preparation.pipeline_info
            should_trigger_ai = preparation.should_trigger_ai
            _, rag_prompt = await process_context_and_rag(
                message=effective_message,
                contexts=payload.contexts,
                should_trigger_ai=should_trigger_ai,
                user_id=user_id,
                db=None,
            )
            params = _build_chat_task_creation_params(
                payload,
                effective_message,
                pipeline_info,
            )
            if payload.client_origin == CLIENT_ORIGIN_WEWORK and not payload.task_id:
                from app.services.chat.wework_task_defaults import (
                    apply_wework_task_defaults_nonblocking,
                )

                params = await apply_wework_task_defaults_nonblocking(
                    user=user,
                    params=params,
                )
            params.device_id = await run_sync_in_executor(
                _resolve_chat_send_device_id,
                user_id,
                params,
                payload.task_id,
            )

            from app.services.chat.storage import create_chat_task_nonblocking

            result = await create_chat_task_nonblocking(
                user_id=user_id,
                team_id=team.id,
                message=effective_message,
                params=params,
                task_id=payload.task_id,
                should_trigger_ai=should_trigger_ai,
                rag_prompt=rag_prompt,
                detach_memory_save=True,
            )
            task = result.task
            user_subtask = result.user_subtask
            assistant_subtask = result.assistant_subtask
            await run_sync_in_executor(
                _finalize_chat_send_storage,
                task.id,
                user_subtask.id,
                user_id,
                user_name,
                payload,
            )

            task_room = f"task:{task.id}"
            await self.enter_room(sid, task_room)
            if user_subtask:
                await self._broadcast_user_message(
                    user_subtask_id=user_subtask.id,
                    task_id=task.id,
                    message=effective_message,
                    user_id=user_id,
                    user_name=user_name,
                    task_room=task_room,
                    skip_sid=sid,
                )
            if should_trigger_ai and assistant_subtask:
                device_id = params.device_id
                previous_bot_id = (
                    pipeline_info.get("current_stage_bot_id") if pipeline_info else None
                )

                async def _trigger_ai():
                    try:
                        await trigger_ai_response_unified(
                            task=task,
                            assistant_subtask=assistant_subtask,
                            team=team,
                            user=user,
                            message=effective_message,
                            payload=payload,
                            task_room=task_room,
                            device_id=device_id,
                            namespace=self,
                            user_subtask_id=user_subtask.id,
                            auth_token=auth_token,
                            previous_bot_id=previous_bot_id,
                        )
                    except Exception as e:
                        logger.exception(
                            f"[WS] chat:send AI trigger failed: task_id={task.id}, error={e}"
                        )
                        if getattr(e, "_frontend_error_emitted", False):
                            logger.info(
                                "[WS] chat:send skipping fallback chat:error because "
                                "ExecutionDispatcher already emitted it: task_id=%s, subtask_id=%s",
                                task.id,
                                assistant_subtask.id,
                            )
                            return

                        from shared.utils.error_classifier import (
                            classify_error,
                            format_error_message,
                        )

                        error_code = classify_error(e)
                        error_message = format_error_message(e)

                        try:
                            await _finalize_failed_ai_trigger(
                                task_id=task.id,
                                assistant_subtask_id=assistant_subtask.id,
                                error_message=error_message,
                                error_code=error_code,
                            )
                        except Exception as finalize_error:
                            logger.error(
                                "[WS] chat:send failed to persist async trigger error: "
                                "task_id=%s, subtask_id=%s, error=%s",
                                task.id,
                                assistant_subtask.id,
                                finalize_error,
                                exc_info=True,
                            )

                        # Emit error to frontend so user sees the failure
                        error_payload = await project_model(
                            ChatErrorPayload,
                            {
                                "subtask_id": assistant_subtask.id,
                                "error": error_message,
                                "type": error_code,
                                "message_id": assistant_subtask.message_id,
                                "task_id": task.id,
                            },
                        )
                        await self.emit(
                            ServerEvents.CHAT_ERROR,
                            error_payload,
                            room=task_room,
                        )

                await web_background_task_manager.submit(
                    _trigger_ai,
                    name=f"chat-ai-trigger-{assistant_subtask.id}",
                )

            return {
                "task_id": task.id,
                "subtask_id": user_subtask.id if user_subtask else None,
                "message_id": user_subtask.message_id if user_subtask else None,
            }

        except Exception as e:
            logger.exception(f"[WS] chat:send exception: {e}")
            error_response = {"error": str(e)}
            logger.info(f"[WS] chat:send returning error response: {error_response}")
            return error_response

    async def _broadcast_user_message(
        self,
        user_subtask_id: int,
        task_id: int,
        message: str,
        user_id: int,
        user_name: str,
        task_room: str,
        skip_sid: str,
    ):
        """
        Broadcast user message to task room (exclude sender).

        This helper method builds context info and emits the chat:message event
        to notify other group members about the new message.

        Args:
            user_subtask_id: User subtask ID
            task_id: Task ID
            message: Message content
            user_id: Sender's user ID
            user_name: Sender's user name
            task_room: Task room name
            skip_sid: Socket ID to skip (sender)
        """
        message_payload = await run_sync_in_executor(
            _build_user_message_payload,
            user_subtask_id,
            task_id,
            message,
            user_id,
            user_name,
        )
        contexts_list = message_payload["contexts"]

        # DEBUG: Log contexts being sent via WebSocket
        for ctx_dict in contexts_list:
            if ctx_dict.get("context_type") == "table":
                logger.info(
                    f"[WS] Sending table context via WebSocket: id={ctx_dict.get('id')}, "
                    f"name={ctx_dict.get('name')}, source_config={ctx_dict.get('source_config')}"
                )

        logger.info(
            f"[WS] Broadcasting user message to room: room={task_room}, "
            f"skip_sid={skip_sid}, message_id={message_payload['message_id']}, "
            f"sender_user_id={user_id}, sender_user_name={user_name}, "
            f"contexts_count={len(contexts_list)}"
        )

        await self.emit(
            ServerEvents.CHAT_MESSAGE,
            message_payload,
            room=task_room,
            skip_sid=skip_sid,
        )

        logger.info(
            f"[WS] User message broadcasted successfully: "
            f"room={task_room}, message_id={message_payload['message_id']}, "
            f"content_length={len(message)}"
        )

    @auto_task_context(
        ChatCancelPayload, task_id_field=None, subtask_id_field="subtask_id"
    )
    async def on_chat_cancel(self, sid: str, data: dict) -> dict:
        """
        Handle chat:cancel event.

        Args:
            sid: Socket ID
            data: {"subtask_id": int, "partial_content": str?}

        Returns:
            {"success": true} or {"error": "..."}
        """
        payload = data  # Already validated by decorator

        # Check token expiry before processing
        if await self._check_token_expiry(sid):
            return await self._handle_token_expired(sid)

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            logger.error("[WS] chat:cancel error: Not authenticated")
            return {"error": "Not authenticated"}

        try:
            # Verify ownership - run in executor to avoid blocking
            subtask_info = await run_sync_in_executor(
                _get_subtask_for_cancel, payload.subtask_id
            )

            if not subtask_info:
                logger.error(
                    f"[WS] chat:cancel error: Subtask not found subtask_id={payload.subtask_id} user_id={user_id}"
                )
                return {"error": "Subtask not found"}

            if subtask_info["status"] not in [
                SubtaskStatus.PENDING,
                SubtaskStatus.RUNNING,
            ]:
                logger.warning(
                    f"[WS] chat:cancel error: Cannot cancel subtask in {subtask_info['status'].value} state"
                )
                return {
                    "error": f"Cannot cancel subtask in {subtask_info['status'].value} state"
                }

            # Use ExecutionDispatcher to handle cancel request
            # This ensures unified cancel logic across all execution modes
            from app.services.execution.dispatcher import execution_dispatcher
            from shared.models import ExecutionRequest

            # Determine device_id if this is a device task
            device_id = None
            executor_name = subtask_info.get("executor_name")
            is_device_task = executor_name and executor_name.startswith("device-")
            if is_device_task:
                device_id = executor_name[7:]  # Remove "device-" prefix

            # Build minimal ExecutionRequest for cancel routing
            # Router only needs bot[0].shell_type and user.id
            cancel_request = ExecutionRequest(
                task_id=subtask_info["task_id"],
                subtask_id=payload.subtask_id,
                bot=[{"shell_type": payload.shell_type or "Chat"}],
                user={"id": user_id},
                executor_name=executor_name,
            )

            logger.info(
                f"[WS] chat:cancel Dispatching cancel via ExecutionDispatcher: "
                f"task_id={subtask_info['task_id']}, subtask_id={payload.subtask_id}, "
                f"shell_type={payload.shell_type}, device_id={device_id}, "
                f"executor_name={executor_name}"
            )

            await run_sync_in_executor(
                _mark_task_and_board_cancelling,
                payload.subtask_id,
            )

            # Deliver the cancellation intent. Terminal status remains owned by
            # the Runtime callback rather than this request path.
            cancel_success = await execution_dispatcher.cancel(
                cancel_request, device_id
            )

            if not cancel_success:
                logger.error(
                    "[WS] chat:cancel Runtime did not acknowledge cancellation "
                    "for subtask_id=%s",
                    payload.subtask_id,
                )
                return {"error": "Runtime did not acknowledge cancellation"}

            logger.info(
                "[WS] chat:cancel Runtime acknowledged cancellation "
                "for subtask_id=%s",
                payload.subtask_id,
            )
            return {"success": True}

        except Exception as e:
            logger.error(f"[WS] chat:cancel exception: {e}", exc_info=True)
            return {"error": f"Internal server error: {str(e)}"}

    async def on_task_close_session(self, sid: str, data: dict) -> dict:
        """
        Handle task:close-session event.

        Sends close-session WebSocket event to device to terminate the session
        and free up the device slot.

        Args:
            sid: Socket ID
            data: {"task_id": int}

        Returns:
            {"success": true} or {"error": "..."}
        """
        # Check token expiry before processing
        if await self._check_token_expiry(sid):
            return await self._handle_token_expired(sid)

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            logger.error("[WS] task:close-session error: Not authenticated")
            return {"error": "Not authenticated"}

        task_id = data.get("task_id")
        if not task_id:
            logger.error("[WS] task:close-session error: Missing task_id")
            return {"error": "Missing task_id"}

        try:
            # Get device info - run in executor to avoid blocking
            device_info = await run_sync_in_executor(
                _get_device_info_for_close_session,
                task_id,
                user_id,
            )

            if device_info.get("error"):
                logger.error(
                    f"[WS] task:close-session error: {device_info['error']} task_id={task_id} user_id={user_id}"
                )
                return {"error": device_info["error"]}

            device_id = device_info["device_id"]
            device_owner_user_id = device_info["user_id"]
            device_room = f"device:{device_owner_user_id}:{device_id}"

            logger.info(
                f"[WS] task:close-session Sending task:close-session to device: "
                f"device_id={device_id}, room={device_room}, task_id={task_id}"
            )

            from app.core.socketio import get_sio

            sio = get_sio()
            await sio.emit(
                "task:close-session",
                {"task_id": task_id},
                room=device_room,
                namespace="/local-executor",
            )

            logger.info(
                f"[WS] task:close-session Successfully sent to device for task_id={task_id}"
            )

            return {"success": True}

        except Exception as e:
            logger.error(f"[WS] task:close-session exception: {e}", exc_info=True)
            return {"error": f"Internal server error: {str(e)}"}

    @auto_task_context(
        ChatRetryPayload, task_id_field="task_id", subtask_id_field="subtask_id"
    )
    async def on_chat_retry(self, sid: str, data: dict) -> dict:
        """
        Handle chat:retry event to retry a failed chat message.

        This implements the Same-ID retry mechanism: instead of creating a new subtask,
        it resets the existing failed AI subtask to PENDING status and triggers a new
        AI response. This maintains message order and preserves the conversation flow.

        Key features:
        - Reuses the same subtask_id and message_id for consistency
        - Preserves model override information from task metadata
        - Supports both direct chat (streaming) and executor-based execution
        - Performs optimized database queries using JOIN to reduce round trips

        Args:
            sid: Socket.IO session ID
            data: Validated payload containing task_id and subtask_id

        Returns:
            dict: Success/error response

        Raises:
            No exceptions - all errors are caught and returned as error dict
        """
        payload = data  # Already validated by decorator
        logger.info(
            f"[WS] chat:retry received sid={sid}, "
            f"raw_data_type={type(data)}, "
            f"payload={payload}, "
            f"force_override_bot_model={payload.force_override_bot_model} (type={type(payload.force_override_bot_model)}), "
            f"force_override_bot_model_type={payload.force_override_bot_model_type} (type={type(payload.force_override_bot_model_type)})"
        )

        # Check token expiry before processing
        if await self._check_token_expiry(sid):
            return await self._handle_token_expired(sid)

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            logger.error("[WS] chat:retry error: Not authenticated")
            return {"error": "Not authenticated"}

        # Check permission: verify user has access to the task
        if not await can_access_task(user_id, payload.task_id):
            logger.error(
                f"[WS] chat:retry error: Access denied for user={user_id} task={payload.task_id}"
            )
            return {"error": "Access denied"}

        try:
            dispatch_args_or_error = await run_sync_in_executor(
                _prepare_chat_retry_dispatch_for_user,
                payload,
                user_id,
            )
        except ValueError as e:
            # Validation errors, data parsing errors
            logger.error(f"[WS] chat:retry validation error: {e}", exc_info=True)

            # Broadcast error via ExecutionDispatcher
            # Note: We don't pass emitter here since this is a validation error
            # that doesn't need frontend notification through the emitter chain.
            # The error is returned directly to the caller via WebSocket ACK.
            return {"error": f"Invalid data: {str(e)}"}
        except PermissionError as e:
            # Permission/access errors
            logger.error(f"[WS] chat:retry permission error: {e}", exc_info=True)

            # Permission errors are returned directly to the caller
            return {"error": f"Access denied: {str(e)}"}
        except Exception as e:
            # Catch SQLAlchemy errors and other unexpected exceptions
            from sqlalchemy.exc import SQLAlchemyError

            logger.error(f"[WS] chat:retry exception: {e}", exc_info=True)

            # Return error directly to the caller
            error_msg = (
                "Database error occurred"
                if isinstance(e, SQLAlchemyError)
                else f"Internal server error: {str(e)}"
            )
            return {"error": error_msg}
        if "error" in dispatch_args_or_error:
            return dispatch_args_or_error

        assistant_subtask = dispatch_args_or_error["assistant_subtask"]
        task_room = dispatch_args_or_error["task_room"]

        async def _trigger_retry_ai() -> None:
            try:
                await trigger_ai_response_unified(
                    namespace=self,
                    **dispatch_args_or_error,
                )
            except Exception as error:
                from shared.utils.error_classifier import (
                    classify_error,
                    format_error_message,
                )

                error_message = format_error_message(error)
                error_code = classify_error(error)
                logger.error(
                    "[WS] chat:retry async trigger failed: task_id=%s, "
                    "subtask_id=%s, error=%s",
                    payload.task_id,
                    assistant_subtask.id,
                    error,
                    exc_info=True,
                )
                try:
                    await _finalize_failed_ai_trigger(
                        task_id=payload.task_id,
                        assistant_subtask_id=assistant_subtask.id,
                        error_message=error_message,
                        error_code=error_code,
                    )
                except Exception as finalize_error:
                    logger.error(
                        "[WS] chat:retry failed to persist trigger error: "
                        "task_id=%s, subtask_id=%s, error=%s",
                        payload.task_id,
                        assistant_subtask.id,
                        finalize_error,
                        exc_info=True,
                    )

                error_payload = await project_model(
                    ChatErrorPayload,
                    {
                        "subtask_id": assistant_subtask.id,
                        "error": error_message,
                        "type": error_code,
                        "message_id": assistant_subtask.message_id,
                        "task_id": payload.task_id,
                    },
                )
                await self.emit(
                    ServerEvents.CHAT_ERROR,
                    error_payload,
                    room=task_room,
                )

        await web_background_task_manager.submit(
            _trigger_retry_ai,
            name=f"chat-retry-ai-trigger-{assistant_subtask.id}",
        )

        logger.info(
            "[WS] chat:retry AI response admitted for subtask_id=%s",
            assistant_subtask.id,
        )
        return {"success": True}

    @auto_task_context(
        ChatResumePayload, task_id_field="task_id", subtask_id_field="subtask_id"
    )
    async def on_chat_resume(self, sid: str, data: dict) -> dict:
        """
        Handle chat:resume event.

        Args:
            sid: Socket ID
            data: {"task_id": int, "subtask_id": int, "offset": int}

        Returns:
            {"success": true} or {"error": "..."}
        """
        payload = data  # Already validated by decorator

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        # Verify access
        if not await can_access_task(user_id, payload.task_id):
            return {"error": "Access denied"}

        owns_subtask = await run_sync_in_executor(
            _subtask_belongs_to_task,
            payload.subtask_id,
            payload.task_id,
        )
        if not owns_subtask:
            return {"error": "Access denied"}

        # Join task room
        task_room = f"task:{payload.task_id}"
        await self.enter_room(sid, task_room)

        try:
            recovery = await _load_subtask_recovery(
                payload.subtask_id,
                offset=payload.offset,
                include_blocks=False,
                include_context_metrics=True,
            )
        except RuntimeError as error:
            logger.error(
                "[WS] chat:resume recovery failed: subtask_id=%s error=%s",
                payload.subtask_id,
                error,
            )
            return {"error": "Streaming recovery is unavailable"}

        remaining = recovery["content"]
        if remaining:
            from app.api.ws.events import ServerEvents

            await self.emit(
                ServerEvents.CHAT_CHUNK,
                {
                    "subtask_id": payload.subtask_id,
                    "content": remaining,
                    "offset": payload.offset,
                },
                to=sid,
            )

        cached_context_metrics = recovery["context_metrics"]
        if cached_context_metrics:
            from app.api.ws.events import ServerEvents

            await self.emit(
                ServerEvents.CHAT_STATUS_UPDATED,
                cached_context_metrics,
                to=sid,
            )

        return {"success": True}

    @auto_task_context(HistorySyncPayload)
    async def on_history_sync(self, sid: str, data: dict) -> dict:
        """
        Handle history:sync event.

        Args:
            sid: Socket ID
            data: {"task_id": int, "after_message_id": int}

        Returns:
            {"messages": [...]} or {"error": "..."}
        """
        payload = data  # Already validated by decorator

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        # Verify access
        if not await can_access_task(user_id, payload.task_id):
            return {"error": "Access denied"}

        # Fetch messages - run in executor to avoid blocking
        messages = await run_sync_in_executor(
            _fetch_history_messages, payload.task_id, user_id, payload.after_message_id
        )

        return {"messages": messages}

    # ============================================================
    # Generic Skill Events
    # ============================================================

    async def on_skill_response(self, sid: str, data: dict) -> dict:
        """
        Handle generic skill response from frontend.

        This is the unified handler for all skill responses.
        Uses Redis-backed PendingRequestRegistry for cross-worker support.

        Args:
            sid: Socket ID
            data: SkillResponsePayload fields

        Returns:
            {"success": true} or {"error": "..."}
        """
        from app.api.ws.events import SkillResponsePayload
        from chat_shell.tools import (
            get_pending_request_registry,
        )

        request_id = data.get("request_id")
        skill_name = data.get("skill_name")
        action = data.get("action")
        success = data.get("success", False)
        result = data.get("result")
        error = data.get("error")

        if not request_id:
            logger.warning("[WS] skill:response received without request_id")
            return {"error": "Missing request_id"}

        logger.info(
            f"[WS] skill:response received: {skill_name}:{action} "
            f"for request {request_id}, success={success}"
        )

        # Get registry (async to ensure Pub/Sub listener is started)
        registry = await get_pending_request_registry()

        # Build a complete result object that includes the success flag
        # This is needed because tools like render_mermaid expect result.get("success")
        complete_result = {
            "success": success,
            "result": result,
            "error": error,
        }

        resolved = await registry.resolve(
            request_id=request_id,
            result=complete_result,
            error=None,  # Error is now part of complete_result
        )

        if not resolved:
            logger.warning(
                f"[WS] skill:response could not resolve request {request_id}"
            )
            return {"error": "No pending request found"}

        logger.info(f"[WS] skill:response resolved request {request_id}")
        return {"success": True}


def register_chat_namespace(sio: socketio.AsyncServer):
    """
    Register the chat namespace with the Socket.IO server.

    Args:
        sio: Socket.IO server instance
    """
    chat_ns = ChatNamespace("/chat")
    sio.register_namespace(chat_ns)
    logger.info("Chat namespace registered at /chat")


def get_device_id(task):
    """Extract device_id from a task's CRD spec."""
    task_crd = Task.model_validate(task.json)
    return task_crd.spec.device_id if task_crd.spec else None


def _is_code_wiki_task(task: TaskResource) -> bool:
    """Whether a task has a generation-bound Code Wiki runtime prompt."""
    task_json = task.json if isinstance(task.json, dict) else {}
    metadata = task_json.get("metadata") or {}
    labels = metadata.get("labels") if isinstance(metadata, dict) else {}
    return isinstance(labels, dict) and labels.get("source") == "code_wiki"


def _prepare_chat_send(
    user_id: int,
    request_payload: ChatSendPayload,
) -> _ChatSendPreparation:
    """Load and validate a chat send request inside one worker-owned session."""
    from app.services.chat.config import is_deep_research_protocol
    from app.services.chat.trigger import should_trigger_ai_response

    payload = request_payload.model_copy(deep=True)
    with get_db_session() as db:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            return _ChatSendPreparation(
                payload=payload, response={"error": "User not found"}
            )

        team = (
            db.query(Kind)
            .filter(
                Kind.id == payload.team_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )
        if not team:
            return _ChatSendPreparation(
                payload=payload, response={"error": "Team not found"}
            )

        team_crd = Team.model_validate(team.json)
        pipeline_info = None
        if team_crd.spec.collaborationModel == "pipeline":
            if payload.action == "pipeline:confirm":
                db.refresh(user)
                db.refresh(team)
                db.expunge(user)
                db.expunge(team)
                return _ChatSendPreparation(
                    payload=payload,
                    user=user,
                    team=team,
                    pipeline_confirm=True,
                )

            from app.services.adapters.pipeline_stage import pipeline_stage_service

            pipeline_info = pipeline_stage_service.get_pipeline_info(
                db=db,
                team=team,
                task_id=payload.task_id,
            )
            if pipeline_info and pipeline_info.get("is_pipeline_complete"):
                return _ChatSendPreparation(
                    payload=payload,
                    response={
                        "task_id": payload.task_id,
                        "current_stage": pipeline_info.get("current_stage"),
                        "total_stages": pipeline_info.get("total_stages"),
                        "pipeline_completed": True,
                    },
                )

        if payload.task_id and is_deep_research_protocol(db, team):
            return _ChatSendPreparation(
                payload=payload,
                response={
                    "error": "Deep Research does not support follow-up questions. Please start a new conversation."
                },
            )

        if payload.task_id:
            from app.services.chat.interactive_forms import (
                validate_interactive_form_answer,
            )

            form_validation = validate_interactive_form_answer(
                db,
                task_id=payload.task_id,
                answer=payload.interactive_form_answer,
            )
            if not form_validation.ok:
                return _ChatSendPreparation(
                    payload=payload,
                    response={
                        "error": form_validation.error,
                        "message": form_validation.message,
                    },
                )

        _apply_artifact_node_scope(db=db, user=user, payload=payload)
        existing_task = None
        task_json: Dict[str, Any] = {}
        if payload.task_id:
            existing_task = task_stores.task_store.get_regular_active_task(
                db, task_id=payload.task_id
            )
            if existing_task:
                task_json = existing_task.json or {}

        should_trigger_ai = should_trigger_ai_response(
            task_json,
            payload.message,
            team.name,
            request_is_group_chat=payload.is_group_chat,
        )
        db.refresh(user)
        db.refresh(team)
        db.expunge(user)
        db.expunge(team)
        return _ChatSendPreparation(
            payload=payload,
            user=user,
            team=team,
            pipeline_info=pipeline_info,
            should_trigger_ai=should_trigger_ai,
        )


def _build_chat_task_creation_params(
    payload: ChatSendPayload,
    message: str,
    pipeline_info: Optional[Dict[str, Any]],
):
    """Build persistence parameters from an already validated payload."""
    from app.services.chat.storage import TaskCreationParams

    additional_skills = None
    if payload.additional_skills:
        additional_skills = [
            {
                "name": skill.name,
                "namespace": skill.namespace,
                "is_public": skill.is_public,
            }
            for skill in payload.additional_skills
        ]
    generation = None
    if payload.generate_params:
        generation = payload.generate_params.model_dump(mode="json")

    execution_workspace = None
    if (
        not payload.task_id
        and payload.execution
        and payload.execution.workspace
        and payload.execution.workspace.source == "git_worktree"
    ):
        if not payload.project_id:
            raise ValueError("Git worktree execution requires a project")
        execution_workspace = {"source": "git_worktree"}
        branch = (payload.execution.workspace.branch or "").strip()
        if branch:
            execution_workspace["branch"] = branch

    return TaskCreationParams(
        message=message,
        title=payload.title,
        model_id=payload.force_override_bot_model,
        force_override_bot_model=payload.force_override_bot_model is not None,
        force_override_bot_model_type=payload.force_override_bot_model_type,
        model_options=payload.model_options,
        is_group_chat=payload.is_group_chat,
        git_url=payload.git_url,
        git_repo=payload.git_repo,
        git_repo_id=payload.git_repo_id,
        git_domain=payload.git_domain,
        branch_name=payload.branch_name,
        task_type=payload.task_type,
        knowledge_base_id=payload.knowledge_base_id,
        additional_skills=additional_skills,
        pipeline_bot_ids=pipeline_info.get("bot_ids") if pipeline_info else None,
        previous_bot_id=(
            pipeline_info.get("current_stage_bot_id") if pipeline_info else None
        ),
        skip_status_check=payload.action == "pipeline:confirm",
        device_id=payload.device_id,
        project_id=payload.project_id,
        execution_workspace=execution_workspace,
        client_origin=payload.client_origin,
        generate_params=generation,
    )


def _resolve_chat_send_device_id(
    user_id: int,
    params,
    task_id: Optional[int],
) -> Optional[str]:
    """Resolve a device using a session local to the database worker."""
    with get_db_session() as db:
        task = (
            task_stores.task_store.get_regular_active_task(db, task_id=task_id)
            if task_id
            else None
        )
        return resolve_chat_task_device_id(
            db,
            user_id=user_id,
            params=params,
            task=task,
        )


def _finalize_chat_send_storage(
    task_id: int,
    user_subtask_id: int,
    user_id: int,
    user_name: str,
    payload: ChatSendPayload,
) -> None:
    """Persist labels and contexts after task creation in a fresh session."""
    from app.services.chat.preprocessing import link_contexts_to_subtask

    with get_db_session() as db:
        task = task_stores.task_store.get_regular_active_task(db, task_id=task_id)
        if not task:
            raise ValueError("Task not found after creation")

        task_crd = Task.model_validate(task.json)
        labels = task_crd.metadata.labels or {}
        if (
            labels.get("type") == "subscription"
            and labels.get("userInteracted") != "true"
        ):
            labels["userInteracted"] = "true"
            task_crd.metadata.labels = labels
            task_stores.task_store.update_json(
                db, task=task, payload=task_crd.model_dump(mode="json")
            )

        attachment_ids = list(payload.attachment_ids or [])
        if not attachment_ids and payload.attachment_id:
            attachment_ids = [payload.attachment_id]
        if attachment_ids or payload.contexts:
            link_contexts_to_subtask(
                db=db,
                subtask_id=user_subtask_id,
                user_id=user_id,
                attachment_ids=attachment_ids or None,
                contexts=payload.contexts,
                task=task,
                user_name=user_name,
            )


def _prepare_chat_retry_dispatch(
    db: Session,
    payload: ChatRetryPayload,
    user_id: int,
) -> Dict[str, Any]:
    """Prepare retry dispatch arguments while the DB session is still open."""
    # Fetch all required entities using optimized query from service module
    failed_ai_subtask, task, team, user_subtask = fetch_retry_context(
        db, payload.task_id, payload.subtask_id
    )

    # Validate entities exist
    if not failed_ai_subtask:
        logger.error(
            f"[WS] chat:retry error: AI subtask not found id={payload.subtask_id}"
        )
        return {"error": "AI subtask not found"}

    if not task:
        logger.error(f"[WS] chat:retry error: Task not found id={payload.task_id}")
        return {"error": "Task not found"}

    if not team:
        logger.error(
            f"[WS] chat:retry error: Team not found id={failed_ai_subtask.team_id}"
        )
        return {"error": "Team not found"}

    if not user_subtask:
        logger.error(
            f"[WS] chat:retry error: User subtask not found parent_id={failed_ai_subtask.parent_id}"
        )
        return {"error": "User message not found"}

    if _is_code_wiki_task(task):
        logger.info(
            "[WS] chat:retry rejected for Code Wiki task_id=%s; "
            "a new wiki generation is required",
            task.id,
        )
        return {
            "error": "Code Wiki task retry is not supported. Start a new Code Wiki generation."
        }

    logger.info(
        f"[WS] chat:retry found failed_ai_subtask: id={failed_ai_subtask.id}, "
        f"message_id={failed_ai_subtask.message_id}, "
        f"parent_id={failed_ai_subtask.parent_id}, "
        f"status={failed_ai_subtask.status.value}"
    )
    logger.info(
        f"[WS] chat:retry found user_subtask: id={user_subtask.id}, "
        f"prompt={user_subtask.prompt[:50] if user_subtask.prompt else ''}..."
    )

    retryable_statuses = {
        SubtaskStatus.FAILED.value,
        SubtaskStatus.CANCELLED.value,
    }
    current_status = (
        failed_ai_subtask.status.value
        if hasattr(failed_ai_subtask.status, "value")
        else str(failed_ai_subtask.status)
    )
    if current_status not in retryable_statuses:
        logger.warning(
            "[WS] chat:retry rejected non-terminal failed subtask: "
            "task_id=%s, subtask_id=%s, status=%s",
            payload.task_id,
            failed_ai_subtask.id,
            current_status,
        )
        return {"error": f"Cannot retry subtask in {current_status} state"}

    # Reset the failed AI subtask to PENDING status using service module.
    # Also pass task to reset Task status so executor_manager can pick it up.
    reset_subtask_for_retry(db, failed_ai_subtask, task)

    from app.models.user import User

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        logger.error(f"[WS] chat:retry error: User not found id={user_id}")
        return {"error": "User not found"}

    model_id = None
    model_type = None

    if payload.use_model_override:
        model_id = payload.force_override_bot_model
        model_type = payload.force_override_bot_model_type
        logger.info(
            f"[WS] chat:retry use_model_override=True, using model from payload: "
            f"model_id={model_id}, model_type={model_type}"
        )
    else:
        task_model_id, force_override = extract_model_override_info(task)
        if force_override and task_model_id:
            model_id = task_model_id
            logger.info(
                f"[WS] chat:retry use_model_override=False, using model from task metadata: "
                f"model_id={model_id}"
            )
        else:
            logger.info(
                "[WS] chat:retry use_model_override=False, no task metadata model, "
                "will use bot's default model"
            )

    if model_id:
        task_json = task.json or {}
        labels = task_json.setdefault("metadata", {}).setdefault("labels", {})
        labels["modelId"] = model_id
        labels["forceOverrideBotModel"] = "true"
        if model_type:
            labels["forceOverrideBotModelType"] = model_type
        else:
            labels.pop("forceOverrideBotModelType", None)
        task_stores.task_store.update_json(db, task=task, payload=task_json)
        db.commit()
        db.refresh(task)
        logger.info(
            f"[WS] chat:retry updated task labels: modelId={model_id}, "
            f"modelType={model_type}"
        )
    elif payload.use_model_override:
        # "Default Model" retry: clear stale override labels so the bot default is used.
        task_json = task.json or {}
        labels = task_json.get("metadata", {}).get("labels", {})
        changed = False
        for key in (
            "modelId",
            "forceOverrideBotModel",
            "forceOverrideBotModelType",
        ):
            if key in labels:
                del labels[key]
                changed = True
        if changed:
            task_stores.task_store.update_json(db, task=task, payload=task_json)
            db.commit()
            db.refresh(task)
            logger.info("[WS] chat:retry cleared stale model override labels")

    # Build payload for AI trigger. If model_id is None, the bot default is used.
    attachment_id = None
    if user_subtask.contexts:
        for ctx in user_subtask.contexts:
            if ctx.context_type == "attachment":
                attachment_id = ctx.id
                logger.info(
                    f"[WS] chat:retry found context: id={attachment_id}, "
                    f"name={ctx.name}"
                )
                break

    user_message = extract_display_prompt(user_subtask.prompt) or ""

    retry_payload = ChatSendPayload(
        task_id=payload.task_id,
        team_id=team.id,
        message=user_message,
        attachment_id=attachment_id,
        generate_params=_get_retry_generate_params(user_subtask),
        force_override_bot_model=model_id,
        force_override_bot_model_type=model_type,
        is_group_chat=False,
    )

    dispatch_args = {
        "task": task,
        "assistant_subtask": failed_ai_subtask,
        "team": team,
        "user": user,
        "message": user_message,
        "payload": retry_payload,
        "task_room": f"task:{payload.task_id}",
        "device_id": get_device_id(task),
        "user_subtask_id": user_subtask.id,
    }

    _detach_retry_dispatch_objects(
        db,
        task=task,
        team=team,
        assistant_subtask=failed_ai_subtask,
        user=user,
    )
    return dispatch_args


def _prepare_chat_retry_dispatch_for_user(
    payload: ChatRetryPayload,
    user_id: int,
) -> Dict[str, Any]:
    """Prepare a retry using a session owned by the database worker thread."""
    db = SessionLocal()
    try:
        return _prepare_chat_retry_dispatch(db, payload, user_id)
    finally:
        db.rollback()
        db.close()


def _detach_retry_dispatch_objects(
    db: Session,
    task,
    team,
    assistant_subtask,
    user,
) -> None:
    """Load ORM attributes and detach objects before the DB session is closed."""
    for obj in (task, team, assistant_subtask, user):
        if hasattr(obj, "_sa_instance_state"):
            db.refresh(obj)
            db.expunge(obj)


# ============================================================
# Sync helper functions for run_sync_in_executor
# These functions run synchronous database operations in a thread pool
# to avoid blocking the event loop
# ============================================================


def _authenticate_websocket_token(token: str) -> Optional[_AuthenticatedSocketUser]:
    """Verify a socket token and copy all ORM-backed data before returning."""
    user = verify_jwt_token(token)
    if not user:
        return None
    return _AuthenticatedSocketUser(
        user_id=user.id,
        user_name=user.user_name,
        token_exp=get_token_expiry(token),
    )


def _validate_chat_guidance(
    task_id: int,
    subtask_id: int,
    team_id: int,
) -> Optional[str]:
    """Validate guidance targets entirely inside a database worker."""
    with get_db_session() as db:
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
            return "Team not found"

        shell_type = get_team_first_bot_shell_type(db, team)
        logger.info("[guidance] team=%s shell_type=%s", team_id, shell_type)
        if shell_type != "Chat":
            return "Guidance is only supported for Chat Shell tasks"

        subtask = task_stores.subtask_store.get_by_id(db, subtask_id=subtask_id)
        if not subtask or subtask.task_id != task_id or subtask.team_id != team_id:
            return "Subtask not found"
    return None


def _build_user_message_payload(
    user_subtask_id: int,
    task_id: int,
    message: str,
    user_id: int,
    user_name: str,
) -> Dict[str, Any]:
    """Serialize a user message without leaking ORM objects to the event loop."""
    from app.services.context import context_service

    with get_db_session() as db:
        user_subtask = task_stores.subtask_store.get_by_id(
            db, subtask_id=user_subtask_id
        )
        if not user_subtask or user_subtask.task_id != task_id:
            raise ValueError("User subtask not found")

        contexts = [
            context.model_dump(mode="json")
            for context in context_service.get_briefs_by_subtask(db, user_subtask.id)
        ]
        source = None
        if isinstance(user_subtask.result, dict):
            result_source = user_subtask.result.get("source")
            if isinstance(result_source, dict):
                source = result_source

        return {
            "subtask_id": user_subtask.id,
            "task_id": task_id,
            "message_id": user_subtask.message_id,
            "role": "user",
            "content": message,
            "sender": {"user_id": user_id, "user_name": user_name},
            "created_at": user_subtask.created_at.isoformat(),
            "attachment": None,
            "attachments": [],
            "contexts": contexts,
            "source": source,
        }


def _fetch_subtasks_for_task_join(
    task_id: int, user_id: int, after_message_id: Optional[int]
) -> Optional[list]:
    """
    Fetch subtasks for task:join event.

    This is a sync helper function that runs in a thread pool executor.

    Args:
        task_id: Task ID
        user_id: User ID for full sync
        after_message_id: Message ID cursor for incremental sync (None for full sync)

    Returns:
        List of subtask dicts or None on error
    """
    with get_db_session() as db:
        if after_message_id is not None:
            # Incremental sync: only fetch messages after the cursor
            from app.services.context import context_service

            items = task_fork_history_resolver.resolve_for_task(
                db,
                task_id=task_id,
                user_id=user_id,
                after_message_id=after_message_id,
            )
            subtasks = [item.subtask for item in items]

            # Convert to dict format matching task detail API
            subtasks_dict = []
            for st in subtasks:
                # Get contexts for this subtask
                contexts_briefs = context_service.get_briefs_by_subtask(db, st.id)
                contexts_list = [ctx.model_dump(mode="json") for ctx in contexts_briefs]

                subtask_dict = {
                    "id": st.id,
                    "message_id": st.message_id,
                    "role": st.role.value,
                    "prompt": extract_display_prompt(st.prompt),
                    "result": sanitize_client_payload(st.result),
                    "status": st.status.value,
                    "progress": st.progress,
                    "created_at": (
                        st.created_at.isoformat() if st.created_at else None
                    ),
                    "updated_at": (
                        st.updated_at.isoformat() if st.updated_at else None
                    ),
                    "completed_at": (
                        st.completed_at.isoformat() if st.completed_at else None
                    ),
                    "contexts": contexts_list,
                    "sender": None,
                }

                # Add sender info for user messages
                if st.role == SubtaskRole.USER and st.user_id:
                    user = db.query(User).filter(User.id == st.user_id).first()
                    if user:
                        subtask_dict["sender"] = {
                            "user_id": user.id,
                            "user_name": user.user_name,
                            "avatar": user.avatar,
                        }

                subtasks_dict.append(subtask_dict)

            return subtasks_dict
        else:
            # Full sync: fetch all messages using existing service
            from app.services.adapters.task_kinds import task_kinds_service

            task_detail = task_kinds_service.get_task_detail(
                db, task_id=task_id, user_id=user_id
            )
            return task_detail.get("subtasks")


def _get_subtask_for_cancel(subtask_id: int) -> Optional[dict]:
    """
    Get subtask info for chat:cancel event.

    Args:
        subtask_id: Subtask ID

    Returns:
        Dict with subtask info or None if not found
    """
    with get_db_session() as db:
        subtask = task_stores.subtask_store.get_by_id(db, subtask_id=subtask_id)

        if not subtask:
            return None

        return {
            "id": subtask.id,
            "task_id": subtask.task_id,
            "status": subtask.status,
            "executor_name": subtask.executor_name,
        }


def _subtask_belongs_to_task(subtask_id: int, task_id: int) -> bool:
    """Return True when *subtask_id* belongs to *task_id*."""
    with get_db_session() as db:
        subtask = task_stores.subtask_store.get_basic_by_id(db, subtask_id=subtask_id)
        return subtask is not None and subtask.task_id == task_id


def _mark_task_and_board_cancelling(subtask_id: int) -> None:
    """Persist native and board cancellation intent before Runtime delivery."""
    with get_db_session() as db:
        subtask = task_stores.subtask_store.get_by_id(db, subtask_id=subtask_id)
        if not subtask:
            return

        # Persist intent only. Runtime callback owns the terminal transition.
        task = task_stores.task_store.get_regular_active_task(
            db, task_id=subtask.task_id
        )
        if not task or not task.json:
            return

        task_crd = Task.model_validate(task.json)
        if task_crd.status:
            task_crd.status.status = "CANCELLING"
            task_crd.status.errorMessage = ""
            task_crd.status.updatedAt = datetime.now()
            task_crd.status.completedAt = None

        task_stores.task_store.update_json(
            db, task=task, payload=task_crd.model_dump(mode="json")
        )
        from app.services.board_team_completion import (
            request_board_team_cancellation,
        )

        request_board_team_cancellation(
            db,
            task_id=task.id,
            subtask_id=subtask.id,
            user_id=task.user_id,
        )


def _get_device_info_for_close_session(task_id: int, user_id: int) -> Optional[dict]:
    """
    Get device info for task:close-session event.

    Args:
        task_id: Task ID
        user_id: Current user ID

    Returns:
        Dict with device_id and user_id, or None if not found
    """
    with get_db_session() as db:
        # Get the task to verify it exists
        task = task_stores.task_store.get_regular_active_task(
            db,
            task_id=task_id,
        )

        if not task:
            return {"error": "Task not found"}
        if not task_stores.task_access_store.is_member(
            db, task_id=task_id, user_id=user_id
        ):
            return {"error": "Access denied"}

        # Get the latest subtask with device executor
        subtask = task_stores.subtask_store.get_latest_device_executor_for_task(
            db,
            task_id=task_id,
            owner_user_id=task.user_id,
        )

        if not subtask:
            return {"error": "No device executor found for this task"}

        # Extract device_id from executor_name (format: "device-{device_id}")
        device_id = subtask.executor_name[7:]  # Remove "device-" prefix

        return {"device_id": device_id, "user_id": task.user_id}


def _fetch_history_messages(task_id: int, user_id: int, after_message_id: int) -> list:
    """
    Fetch history messages for history:sync event.

    Args:
        task_id: Task ID
        user_id: User ID
        after_message_id: Message ID cursor

    Returns:
        List of message dicts
    """
    with get_db_session() as db:
        items = task_fork_history_resolver.resolve_for_task(
            db,
            task_id=task_id,
            user_id=user_id,
            after_message_id=after_message_id,
        )
        subtasks = [item.subtask for item in items]

        messages = []
        for st in subtasks:
            msg = {
                "subtask_id": st.id,
                "message_id": st.message_id,
                "role": st.role.value,
                "content": (
                    extract_display_prompt(st.prompt)
                    if st.role == SubtaskRole.USER
                    else (st.result.get("value", "") if st.result else "")
                ),
                "status": st.status.value,
                "created_at": st.created_at.isoformat() if st.created_at else None,
            }
            messages.append(msg)

        return messages
