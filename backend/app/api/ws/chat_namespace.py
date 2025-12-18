# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat namespace for Socket.IO.

This module implements the /chat namespace for real-time chat communication.
It handles authentication, room management, and chat events.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional

import socketio
from jose import jwt
from pydantic import ValidationError

from app.api.ws.events import (
    ChatCancelPayload,
    ChatResumePayload,
    ChatSendAck,
    ChatSendPayload,
    ClientEvents,
    GenericAck,
    HistorySyncAck,
    HistorySyncPayload,
    TaskJoinAck,
    TaskJoinPayload,
    TaskLeavePayload,
)
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.kind import Bot, Shell, Task, Team
from app.services.chat.session_manager import session_manager

logger = logging.getLogger(__name__)


def verify_jwt_token(token: str) -> Optional[User]:
    """
    Verify JWT token and return user.

    Args:
        token: JWT token string

    Returns:
        User object if valid, None otherwise
    """
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        user_name = payload.get("sub")
        if not user_name:
            return None

        # Get user from database
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.user_name == user_name).first()
            return user
        finally:
            db.close()

    except Exception as e:
        logger.warning(f"JWT verification failed: {e}")
        return None


async def can_access_task(user_id: int, task_id: int) -> bool:
    """
    Check if user can access a task.

    Args:
        user_id: User ID
        task_id: Task ID

    Returns:
        True if user can access the task
    """
    db = SessionLocal()
    try:
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )

        if not task:
            return False

        # User owns the task
        if task.user_id == user_id:
            return True

        # Check if task is shared with user (via SharedTask)
        from app.models.shared_task import SharedTask

        shared = (
            db.query(SharedTask)
            .filter(
                SharedTask.original_task_id == task_id,
                SharedTask.user_id == user_id,
                SharedTask.is_active == True,
            )
            .first()
        )

        if shared is not None:
            return True

        # Check if user is a group chat member (via TaskMember)
        from app.models.task_member import MemberStatus, TaskMember

        member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task_id,
                TaskMember.user_id == user_id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )

        return member is not None

    finally:
        db.close()


async def get_active_streaming(task_id: int) -> Optional[Dict[str, Any]]:
    """
    Check if there's an active streaming session for a task.

    Args:
        task_id: Task ID

    Returns:
        Streaming info dict if active, None otherwise
    """
    db = SessionLocal()
    try:
        # Find running assistant subtask
        subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == SubtaskStatus.RUNNING,
            )
            .order_by(Subtask.id.desc())
            .first()
        )

        if subtask:
            return {
                "subtask_id": subtask.id,
                "user_id": subtask.user_id,
                "started_at": (
                    subtask.created_at.isoformat() if subtask.created_at else None
                ),
            }

        return None

    finally:
        db.close()


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

        # Map colon-separated event names to handler methods
        self._event_handlers: Dict[str, str] = {
            "chat:send": "on_chat_send",
            "chat:cancel": "on_chat_cancel",
            "chat:resume": "on_chat_resume",
            "task:join": "on_task_join",
            "task:leave": "on_task_leave",
            "history:sync": "on_history_sync",
        }

    async def trigger_event(self, event: str, sid: str, *args):
        """
        Override trigger_event to handle colon-separated event names.

        python-socketio's default behavior converts on_xxx methods to xxx events,
        but we need to support colon-separated event names like 'chat:send'.

        Args:
            event: Event name (e.g., 'chat:send')
            sid: Socket ID
            *args: Event arguments

        Returns:
            Result from the event handler
        """
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

        Args:
            sid: Socket ID
            environ: WSGI environ dict
            auth: Authentication data (expected: {"token": "..."})

        Raises:
            ConnectionRefusedError: If authentication fails
        """
        logger.info(f"[WS] Connection attempt sid={sid}")

        # Check auth token
        if not auth or not isinstance(auth, dict):
            logger.warning(f"[WS] Missing auth data sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        token = auth.get("token")
        if not token:
            logger.warning(f"[WS] Missing token in auth sid={sid}")
            raise ConnectionRefusedError("Missing authentication token")

        # Verify token
        user = verify_jwt_token(token)
        if not user:
            logger.warning(f"[WS] Invalid token sid={sid}")
            raise ConnectionRefusedError("Invalid or expired token")

        # Save user info to session
        await self.save_session(
            sid,
            {
                "user_id": user.id,
                "user_name": user.user_name,
            },
        )

        # Join user room
        user_room = f"user:{user.id}"
        await self.enter_room(sid, user_room)

        logger.info(f"[WS] Connected user={user.id} ({user.user_name}) sid={sid}")

    async def on_disconnect(self, sid: str):
        """
        Handle client disconnection.

        Args:
            sid: Socket ID
        """
        try:
            session = await self.get_session(sid)
            user_id = session.get("user_id", "unknown")
            logger.info(f"[WS] Disconnected user={user_id} sid={sid}")
        except Exception:
            logger.info(f"[WS] Disconnected sid={sid}")

    # ============================================================
    # Task Room Events
    # ============================================================

    async def on_task_join(self, sid: str, data: dict) -> dict:
        """
        Handle task:join event.

        Joins the client to a task room and returns streaming info if active.

        Args:
            sid: Socket ID
            data: {"task_id": int}

        Returns:
            {"streaming": {...}} or {"streaming": None} or {"error": "..."}
        """
        try:
            payload = TaskJoinPayload(**data)
        except ValidationError as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        # Check permission
        if not await can_access_task(user_id, payload.task_id):
            return {"error": "Access denied"}

        # Join task room
        task_room = f"task:{payload.task_id}"
        await self.enter_room(sid, task_room)

        logger.info(f"[WS] User {user_id} joined task room {payload.task_id}")

        # Check for active streaming
        streaming_info = await get_active_streaming(payload.task_id)
        if streaming_info:
            subtask_id = streaming_info["subtask_id"]

            # Get cached content from Redis
            cached_content = await session_manager.get_streaming_content(subtask_id)
            offset = len(cached_content) if cached_content else 0

            return {
                "streaming": {
                    "subtask_id": subtask_id,
                    "offset": offset,
                    "cached_content": cached_content or "",
                }
            }

        return {"streaming": None}

    async def on_task_leave(self, sid: str, data: dict) -> dict:
        """
        Handle task:leave event.

        Args:
            sid: Socket ID
            data: {"task_id": int}

        Returns:
            {"success": true}
        """
        try:
            payload = TaskLeavePayload(**data)
        except ValidationError as e:
            return {"error": f"Invalid payload: {e}"}

        task_room = f"task:{payload.task_id}"
        await self.leave_room(sid, task_room)

        session = await self.get_session(sid)
        user_id = session.get("user_id", "unknown")
        logger.info(f"[WS] User {user_id} left task room {payload.task_id}")

        return {"success": True}

    # ============================================================
    # Chat Events
    # ============================================================

    async def on_chat_send(self, sid: str, data: dict) -> dict:
        """
        Handle chat:send event.

        Creates task/subtasks and starts streaming response.

        Args:
            sid: Socket ID
            data: ChatSendPayload fields

        Returns:
            {"task_id": int, "subtask_id": int} or {"error": "..."}
        """
        logger.info(f"[WS] chat:send received sid={sid} data={data}")

        try:
            payload = ChatSendPayload(**data)
            logger.info(
                f"[WS] chat:send payload parsed: team_id={payload.team_id}, task_id={payload.task_id}, message_len={len(payload.message) if payload.message else 0}"
            )
        except ValidationError as e:
            logger.error(f"[WS] chat:send validation error: {e}")
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")
        user_name = session.get("user_name")
        logger.info(f"[WS] chat:send session: user_id={user_id}, user_name={user_name}")

        if not user_id:
            logger.error("[WS] chat:send error: Not authenticated")
            return {"error": "Not authenticated"}

        db = SessionLocal()
        try:
            # Get user
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.error(f"[WS] chat:send error: User not found for id={user_id}")
                return {"error": "User not found"}
            logger.info(f"[WS] chat:send user found: {user.user_name}")

            # Get team
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
                logger.error(
                    f"[WS] chat:send error: Team not found for id={payload.team_id}"
                )
                return {"error": "Team not found"}
            logger.info(f"[WS] chat:send team found: {team.name} (id={team.id})")

            # Import existing helpers from chat endpoint
            from app.api.endpoints.adapter.chat import (
                StreamChatRequest,
                _create_task_and_subtasks,
                _should_trigger_ai_response,
                _should_use_direct_chat,
            )

            # Check if team supports direct chat
            supports_direct_chat = _should_use_direct_chat(db, team, user_id)
            logger.info(f"[WS] chat:send supports_direct_chat={supports_direct_chat}")
            if not supports_direct_chat:
                logger.error(f"[WS] chat:send error: Team does not support direct chat")
                return {"error": "This team does not support direct chat"}

            # Get task JSON for group chat check
            task_json = {}
            if payload.task_id:
                existing_task = (
                    db.query(Kind)
                    .filter(
                        Kind.id == payload.task_id,
                        Kind.kind == "Task",
                        Kind.is_active == True,
                    )
                    .first()
                )
                if existing_task:
                    task_json = existing_task.json or {}

            # Check if AI should be triggered (for group chat with @mention)
            # For existing tasks: use task_json.spec.is_group_chat
            # For new tasks: use payload.is_group_chat from frontend
            team_name = team.name
            should_trigger_ai = _should_trigger_ai_response(
                task_json,
                payload.message,
                team_name,
                request_is_group_chat=payload.is_group_chat,
            )
            logger.info(
                f"[WS] chat:send group chat check: task_id={payload.task_id}, "
                f"is_group_chat={task_json.get('spec', {}).get('is_group_chat', False)}, "
                f"team_name={team_name}, "
                f"should_trigger_ai={should_trigger_ai}"
            )

            # Create StreamChatRequest
            request = StreamChatRequest(
                message=payload.message,
                team_id=payload.team_id,
                task_id=payload.task_id,
                attachment_id=payload.attachment_id,
                enable_web_search=payload.enable_web_search,
                model_id=payload.force_override_bot_model,
                force_override_bot_model=payload.force_override_bot_model is not None,
                is_group_chat=payload.is_group_chat,
            )
            logger.info(f"[WS] chat:send StreamChatRequest created")

            # Create task and subtasks
            logger.info(f"[WS] chat:send calling _create_task_and_subtasks...")
            result = await _create_task_and_subtasks(
                db,
                user,
                team,
                payload.message,
                request,
                payload.task_id,
                should_trigger_ai=should_trigger_ai,
            )
            logger.info(
                f"[WS] chat:send _create_task_and_subtasks returned: ai_triggered={result.get('ai_triggered')}, task_id={result.get('task').id if result.get('task') else None}"
            )

            task = result["task"]
            assistant_subtask = result["assistant_subtask"]
            user_subtask_for_attachment = result["user_subtask"]

            # Link attachment to user subtask if provided
            # This is important for group chat history to include attachment content
            if payload.attachment_id and user_subtask_for_attachment:
                from app.services.attachment import attachment_service

                attachment_service.link_attachment_to_subtask(
                    db=db,
                    attachment_id=payload.attachment_id,
                    subtask_id=user_subtask_for_attachment.id,
                    user_id=user_id,
                )
                logger.info(
                    f"[WS] chat:send linked attachment {payload.attachment_id} to subtask {user_subtask_for_attachment.id}"
                )

            # Check if AI was triggered (for group chat without @mention)
            if not result["ai_triggered"]:
                logger.info(
                    f"[WS] chat:send AI not triggered (group chat without @mention)"
                )
                # Return task_id with ai_triggered=false so frontend knows message was saved
                user_subtask = result["user_subtask"]

                # Join task room and broadcast user message for group chat
                # This allows other group members to see the message in real-time
                task_room = f"task:{task.id}"
                await self.enter_room(sid, task_room)

                if user_subtask:
                    await self._broadcast_user_message(
                        db=db,
                        user_subtask=user_subtask,
                        task_id=task.id,
                        message=payload.message,
                        user_id=user_id,
                        user_name=user_name,
                        attachment_id=payload.attachment_id,
                        task_room=task_room,
                        skip_sid=sid,
                    )
                    logger.info(
                        f"[WS] chat:send broadcasted user message to room (no AI trigger)"
                    )

                return {
                    "task_id": task.id,
                    "subtask_id": user_subtask.id if user_subtask else None,
                    "ai_triggered": False,
                    "message": "Message saved without AI response (use @TeamName to trigger AI)",
                }

            if not assistant_subtask:
                logger.error(
                    f"[WS] chat:send error: Failed to create assistant subtask"
                )
                return {"error": "Failed to create assistant subtask"}

            logger.info(
                f"[WS] chat:send task created: task_id={task.id}, subtask_id={assistant_subtask.id}"
            )

            # Join task room if not already joined
            task_room = f"task:{task.id}"
            await self.enter_room(sid, task_room)
            logger.info(f"[WS] chat:send joined task room: {task_room}")

            # Emit task:created event to user room for task list update
            # This allows other browser tabs/devices to receive the new task notification
            from app.api.ws.events import ServerEvents
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter:
                # Get team name for the event payload
                team_crd = Team.model_validate(team.json)
                team_name = team_crd.metadata.name if team_crd.metadata else team.name

                # Get task title
                task_crd = Task.model_validate(task.json)
                task_title = task_crd.spec.title or ""

                await ws_emitter.emit_task_created(
                    user_id=user_id,
                    task_id=task.id,
                    title=task_title,
                    team_id=team.id,
                    team_name=team_name,
                )
                logger.info(
                    f"[WS] chat:send emitted task:created event for task_id={task.id}"
                )

            # Get user subtask for broadcasting
            user_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == task.id,
                    Subtask.message_id == assistant_subtask.message_id - 1,
                    Subtask.role == SubtaskRole.USER,
                )
                .first()
            )
            logger.info(
                f"[WS] chat:send user_subtask found: {user_subtask.id if user_subtask else None}"
            )

            # Broadcast user message to room (exclude sender)
            if user_subtask:
                await self._broadcast_user_message(
                    db=db,
                    user_subtask=user_subtask,
                    task_id=task.id,
                    message=payload.message,
                    user_id=user_id,
                    user_name=user_name,
                    attachment_id=payload.attachment_id,
                    task_room=task_room,
                    skip_sid=sid,
                )
                logger.info(f"[WS] chat:send broadcasted user message to room")

            # Emit chat:start
            from app.api.ws.events import ServerEvents

            logger.info(f"[WS] chat:send emitting chat:start event")
            await self.emit(
                ServerEvents.CHAT_START,
                {
                    "task_id": task.id,
                    "subtask_id": assistant_subtask.id,
                },
                room=task_room,
            )
            logger.info(f"[WS] chat:send chat:start emitted")

            # Extract data from ORM objects before closing the session
            # This prevents DetachedInstanceError in the background task
            team_data = {
                "id": team.id,
                "user_id": team.user_id,
                "json": team.json,  # Access json while session is still open
            }
            user_data = {
                "id": user.id,
                "user_name": user.user_name,
            }

            # Start streaming in background task
            logger.info(f"[WS] chat:send starting background stream task")
            stream_task = asyncio.create_task(
                self._stream_chat_response(
                    task_id=task.id,
                    subtask_id=assistant_subtask.id,
                    team_data=team_data,
                    user_data=user_data,
                    message=payload.message,
                    payload=payload,
                )
            )
            self._active_streams[assistant_subtask.id] = stream_task
            logger.info(f"[WS] chat:send background stream task started")

            response = {"task_id": task.id, "subtask_id": assistant_subtask.id}
            logger.info(f"[WS] chat:send returning response: {response}")
            return response

        except Exception as e:
            logger.exception(f"[WS] chat:send exception: {e}")
            error_response = {"error": str(e)}
            logger.info(f"[WS] chat:send returning error response: {error_response}")
            return error_response
        finally:
            logger.info(f"[WS] chat:send finally block, closing db")
            db.close()

    async def _broadcast_user_message(
        self,
        db,
        user_subtask: Subtask,
        task_id: int,
        message: str,
        user_id: int,
        user_name: str,
        attachment_id: Optional[int],
        task_room: str,
        skip_sid: str,
    ):
        """
        Broadcast user message to task room (exclude sender).

        This helper method builds attachment info and emits the chat:message event
        to notify other group members about the new message.

        Args:
            db: Database session
            user_subtask: User's subtask object
            task_id: Task ID
            message: Message content
            user_id: Sender's user ID
            user_name: Sender's user name
            attachment_id: Optional attachment ID
            task_room: Task room name
            skip_sid: Socket ID to skip (sender)
        """
        from app.api.ws.events import ServerEvents

        # Build attachment info if present
        attachment_info = None
        if attachment_id:
            from app.services.attachment import attachment_service

            attachment = attachment_service.get_attachment(
                db=db,
                attachment_id=attachment_id,
                user_id=user_id,
            )
            if attachment:
                attachment_info = {
                    "id": attachment.id,
                    "original_filename": attachment.original_filename,
                    "file_extension": attachment.file_extension,
                    "file_size": attachment.file_size,
                    "mime_type": attachment.mime_type,
                    "status": attachment.status.value if attachment.status else None,
                }

        # Build attachments array (supports multiple attachments in the future)
        attachments_list = [attachment_info] if attachment_info else None

        await self.emit(
            ServerEvents.CHAT_MESSAGE,
            {
                "subtask_id": user_subtask.id,
                "task_id": task_id,
                "role": "user",
                "content": message,
                "sender": {
                    "user_id": user_id,
                    "user_name": user_name,
                },
                "created_at": user_subtask.created_at.isoformat(),
                "attachment": attachment_info,  # Keep for backward compatibility
                "attachments": attachments_list,  # New array format
            },
            room=task_room,
            skip_sid=skip_sid,
        )

    async def _stream_chat_response(
        self,
        task_id: int,
        subtask_id: int,
        team_data: Dict[str, Any],
        user_data: Dict[str, Any],
        message: str,
        payload: ChatSendPayload,
    ):
        """
        Stream chat response to task room.

        Args:
            task_id: Task ID
            subtask_id: Assistant subtask ID
            team_data: Dict with team info (id, user_id, json)
            user_data: Dict with user info (id, user_name)
            message: User message
            payload: Original chat send payload
        """
        from app.api.ws.events import ServerEvents
        from app.services.chat.chat_service import chat_service
        from app.services.chat.model_resolver import (
            build_default_headers_with_placeholders,
            get_bot_system_prompt,
            get_model_config_for_bot,
        )
        from app.services.chat.ws_emitter import get_ws_emitter

        db = SessionLocal()
        task_room = f"task:{task_id}"
        offset = 0
        full_response = ""

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
                    Kind.is_active == True,
                )
                .first()
            )

            if not bot:
                await self.emit(
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
            tools = None
            if payload.enable_web_search and settings.WEB_SEARCH_ENABLED:
                from app.services.chat.tools import get_web_search_tool

                web_search_tool = get_web_search_tool()
                if web_search_tool:
                    tools = [web_search_tool]

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
            from app.services.chat.chat_service import chat_service
            from app.services.chat.message_builder import message_builder
            from app.services.chat.providers import get_provider
            from app.services.chat.providers.base import ChunkType

            # Check if this is a group chat - get history from database with user names
            is_group_chat = payload.is_group_chat
            if is_group_chat:
                logger.info(
                    f"[WS] _stream_chat_response: Getting group chat history for task_id={task_id}"
                )
                history = await chat_service._get_group_chat_history(task_id)
                logger.info(
                    f"[WS] _stream_chat_response: Got group chat history: count={len(history)}, "
                    f"roles={[m.get('role') for m in history]}"
                )
                # Apply truncation for group chat
                history = chat_service._truncate_group_chat_history(history, task_id)
                logger.info(
                    f"[WS] _stream_chat_response: After truncation: count={len(history)}"
                )
            else:
                # For regular chat, get history from Redis
                history = await session_manager.get_chat_history(task_id)

            messages = message_builder.build_messages(
                history, final_message, system_prompt
            )
            logger.info(
                f"[WS] _stream_chat_response: Built messages: total={len(messages)}, "
                f"roles={[m.get('role') for m in messages]}"
            )

            client = await get_http_client()
            provider = get_provider(model_config, client)

            if not provider:
                await self.emit(
                    ServerEvents.CHAT_ERROR,
                    {"subtask_id": subtask_id, "error": "Failed to create provider"},
                    room=task_room,
                )
                return

            # Stream response
            last_redis_save = asyncio.get_event_loop().time()
            last_db_save = asyncio.get_event_loop().time()
            redis_save_interval = settings.STREAMING_REDIS_SAVE_INTERVAL
            db_save_interval = settings.STREAMING_DB_SAVE_INTERVAL

            async for chunk in provider.stream_chat(messages, cancel_event, tools=None):
                if cancel_event.is_set() or await session_manager.is_cancelled(
                    subtask_id
                ):
                    # Cancelled
                    await self.emit(
                        ServerEvents.CHAT_CANCELLED,
                        {"subtask_id": subtask_id},
                        room=task_room,
                    )
                    break

                if chunk.type == ChunkType.CONTENT and chunk.content:
                    full_response += chunk.content

                    # Emit chunk
                    await self.emit(
                        ServerEvents.CHAT_CHUNK,
                        {
                            "subtask_id": subtask_id,
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
                        await session_manager.publish_streaming_chunk(
                            subtask_id, chunk.content
                        )
                        last_redis_save = current_time

                    # Save to DB periodically
                    if current_time - last_db_save >= db_save_interval:
                        await db_handler.save_partial_response(
                            subtask_id, full_response
                        )
                        last_db_save = current_time

                elif chunk.type == ChunkType.ERROR:
                    await self.emit(
                        ServerEvents.CHAT_ERROR,
                        {
                            "subtask_id": subtask_id,
                            "error": chunk.error or "Unknown error",
                        },
                        room=task_room,
                    )
                    await db_handler.update_subtask_status(
                        subtask_id, "FAILED", error=chunk.error
                    )
                    return

            # Stream completed
            if not cancel_event.is_set():
                result = {"value": full_response}

                # Save to Redis and DB FIRST before emitting done event
                # This ensures the database is updated before frontend refreshes
                await session_manager.save_streaming_content(subtask_id, full_response)
                await session_manager.publish_streaming_done(subtask_id, result)

                # Save chat history
                await session_manager.append_user_and_assistant_messages(
                    task_id, message, full_response
                )

                # Update subtask to completed
                await db_handler.update_subtask_status(
                    subtask_id, "COMPLETED", result={"value": full_response}
                )

                # Emit done event AFTER database is updated
                # This ensures frontend can immediately fetch the updated data
                await self.emit(
                    ServerEvents.CHAT_DONE,
                    {
                        "subtask_id": subtask_id,
                        "offset": offset,
                        "result": result,
                    },
                    room=task_room,
                )

                # Also notify user room for multi-device sync
                ws_emitter = get_ws_emitter()
                if ws_emitter:
                    await ws_emitter.emit_chat_bot_complete(
                        user_id=user_data["id"],
                        task_id=task_id,
                        subtask_id=subtask_id,
                        content=full_response,
                        result=result,
                    )

        except Exception as e:
            logger.exception(f"[WS] Stream error subtask={subtask_id}: {e}")
            await self.emit(
                ServerEvents.CHAT_ERROR,
                {"subtask_id": subtask_id, "error": str(e)},
                room=task_room,
            )
        finally:
            # Cleanup
            await session_manager.unregister_stream(subtask_id)
            await session_manager.delete_streaming_content(subtask_id)
            if subtask_id in self._active_streams:
                del self._active_streams[subtask_id]
            db.close()

    async def on_chat_cancel(self, sid: str, data: dict) -> dict:
        """
        Handle chat:cancel event.

        Args:
            sid: Socket ID
            data: {"subtask_id": int, "partial_content": str?}

        Returns:
            {"success": true} or {"error": "..."}
        """
        try:
            payload = ChatCancelPayload(**data)
        except ValidationError as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        db = SessionLocal()
        try:
            # Verify ownership
            subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.id == payload.subtask_id,
                    Subtask.user_id == user_id,
                )
                .first()
            )

            if not subtask:
                return {"error": "Subtask not found"}

            if subtask.status not in [SubtaskStatus.PENDING, SubtaskStatus.RUNNING]:
                return {
                    "error": f"Cannot cancel subtask in {subtask.status.value} state"
                }

            # Signal cancellation
            await session_manager.cancel_stream(payload.subtask_id)

            # Update subtask
            subtask.status = SubtaskStatus.COMPLETED
            subtask.progress = 100
            subtask.completed_at = datetime.now()
            subtask.updated_at = datetime.now()

            if payload.partial_content:
                subtask.result = {"value": payload.partial_content}
            else:
                subtask.result = {"value": ""}

            # Update task status
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
                    task_crd.status.status = "COMPLETED"
                    task_crd.status.errorMessage = ""
                    task_crd.status.updatedAt = datetime.now()
                    task_crd.status.completedAt = datetime.now()

                task.json = task_crd.model_dump(mode="json")
                task.updated_at = datetime.now()
                flag_modified(task, "json")

            db.commit()

            return {"success": True}

        finally:
            db.close()

    async def on_chat_resume(self, sid: str, data: dict) -> dict:
        """
        Handle chat:resume event.

        Args:
            sid: Socket ID
            data: {"task_id": int, "subtask_id": int, "offset": int}

        Returns:
            {"success": true} or {"error": "..."}
        """
        try:
            payload = ChatResumePayload(**data)
        except ValidationError as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        # Verify access
        if not await can_access_task(user_id, payload.task_id):
            return {"error": "Access denied"}

        # Join task room
        task_room = f"task:{payload.task_id}"
        await self.enter_room(sid, task_room)

        # Get cached content
        cached_content = await session_manager.get_streaming_content(payload.subtask_id)

        if cached_content and payload.offset < len(cached_content):
            # Send remaining content
            remaining = cached_content[payload.offset :]
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

        return {"success": True}

    async def on_history_sync(self, sid: str, data: dict) -> dict:
        """
        Handle history:sync event.

        Args:
            sid: Socket ID
            data: {"task_id": int, "after_message_id": int}

        Returns:
            {"messages": [...]} or {"error": "..."}
        """
        try:
            payload = HistorySyncPayload(**data)
        except ValidationError as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        # Verify access
        if not await can_access_task(user_id, payload.task_id):
            return {"error": "Access denied"}

        db = SessionLocal()
        try:
            # Get messages after the specified ID
            subtasks = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == payload.task_id,
                    Subtask.message_id > payload.after_message_id,
                )
                .order_by(Subtask.message_id.asc())
                .all()
            )

            messages = []
            for st in subtasks:
                msg = {
                    "subtask_id": st.id,
                    "message_id": st.message_id,
                    "role": st.role.value,
                    "content": (
                        st.prompt
                        if st.role == SubtaskRole.USER
                        else (st.result.get("value", "") if st.result else "")
                    ),
                    "status": st.status.value,
                    "created_at": st.created_at.isoformat() if st.created_at else None,
                }
                messages.append(msg)

            return {"messages": messages}

        finally:
            db.close()


def register_chat_namespace(sio: socketio.AsyncServer):
    """
    Register the chat namespace with the Socket.IO server.

    Args:
        sio: Socket.IO server instance
    """
    chat_ns = ChatNamespace("/chat")
    sio.register_namespace(chat_ns)
    logger.info("Chat namespace registered at /chat")
