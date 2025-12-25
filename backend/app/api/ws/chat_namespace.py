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
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

import socketio
from jose import jwt
from shared.telemetry.context import (
    set_request_context,
    set_user_context,
)
from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.api.ws.context_decorators import auto_task_context
from app.api.ws.decorators import trace_websocket_event
from app.api.ws.events import (
    ChatCancelPayload,
    ChatResumePayload,
    ChatRetryPayload,
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
from app.services.chat.rag_integration import retrieve_and_assemble_rag_prompt
from app.services.chat.session_manager import session_manager

logger = logging.getLogger(__name__)


async def call_executor_cancel(task_id: int) -> bool:
    """
    Call executor_manager to cancel a task.

    Args:
        task_id: Task ID to cancel

    Returns:
        bool: True if successful, False otherwise
    """
    import httpx

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                settings.EXECUTOR_CANCEL_TASK_URL,
                json={"task_id": task_id},
                timeout=5.0,
            )
            response.raise_for_status()
            logger.info(
                f"executor_manager responded successfully for task_id={task_id}"
            )
            return True
    except Exception as e:
        logger.error(
            f"executor_manager call failed for task_id={task_id}: {e}",
            exc_info=True,
        )
        return False


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
        self._stream_versions: Dict[int, str] = {}  # subtask_id -> "v1" | "v2"

        # Map colon-separated event names to handler methods
        self._event_handlers: Dict[str, str] = {
            "chat:send": "on_chat_send",
            "chat:cancel": "on_chat_cancel",
            "chat:resume": "on_chat_resume",
            "chat:retry": "on_chat_retry",
            "task:join": "on_task_join",
            "task:leave": "on_task_leave",
            "history:sync": "on_history_sync",
        }

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

        Args:
            sid: Socket ID
            environ: WSGI environ dict
            auth: Authentication data (expected: {"token": "..."})

        Raises:
            ConnectionRefusedError: If authentication fails
        """
        # Generate unique request ID for this WebSocket connection
        request_id = str(uuid.uuid4())[:8]
        set_request_context(request_id)

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
                "request_id": request_id,
            },
        )

        # Set user context for trace logging
        set_user_context(user_id=str(user.id), user_name=user.user_name)

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

        Joins the client to a task room and returns streaming info if active.

        Args:
            sid: Socket ID
            data: {"task_id": int}

        Returns:
            {"streaming": {...}} or {"streaming": None} or {"error": "..."}
        """
        payload = data  # Already validated by decorator

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

        logger.info(
            f"[WS] User {user_id} joined task room {payload.task_id} (room={task_room}, sid={sid})"
        )

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

    async def _process_rag_if_needed(
        self,
        payload: ChatSendPayload,
        request: Any,
        should_trigger_ai: bool,
        user_id: int,
        db: Session,
    ) -> Optional[tuple[Optional[Dict], Optional[str]]]:
        """
        Process RAG retrieval if contexts with knowledge bases are provided.

        This method:
        1. Extracts knowledge base contexts from payload.contexts
        2. Calls RAG integration service to retrieve and assemble prompt
        3. Returns metadata and RAG prompt separately (does NOT modify payload.message)
        4. The RAG prompt should be used for AI inference, but original message for storage

        Args:
            payload: Chat send payload
            request: Stream chat request
            should_trigger_ai: Whether AI should be triggered
            user_id: User ID
            db: Database session

        Returns:
            Tuple of (context_metadata dict for subtask storage, rag_prompt for AI), or (None, None)
        """
        if not payload.contexts or not should_trigger_ai:
            return None, None

        # Filter knowledge_base type contexts
        kb_contexts = [ctx for ctx in payload.contexts if ctx.type == "knowledge_base"]

        if not kb_contexts:
            return None, None

        logger.info(
            f"[WS] chat:send processing RAG with {len(kb_contexts)} knowledge base contexts"
        )

        # Build metadata for subtask storage
        context_metadata = {
            "contexts": [
                {
                    "type": ctx.type,
                    "data": ctx.data,
                }
                for ctx in payload.contexts
            ],
            "original_query": payload.message,  # Store original query in metadata
        }

        try:
            # Extract knowledge base IDs from context data
            kb_ids = []
            for ctx in kb_contexts:
                try:
                    kb_data = ctx.data
                    knowledge_id = kb_data.get("knowledge_id")

                    # knowledge_id may be string like "kb_001" or int
                    if isinstance(knowledge_id, int):
                        kb_ids.append(knowledge_id)
                    elif isinstance(knowledge_id, str) and knowledge_id.isdigit():
                        kb_ids.append(int(knowledge_id))
                    else:
                        logger.warning(
                            f"[WS] chat:send skipping non-numeric knowledge_id: {knowledge_id}"
                        )
                except (ValueError, AttributeError, KeyError) as e:
                    logger.warning(
                        f"[WS] chat:send failed to parse knowledge_id from context: {e}"
                    )
                    continue

            if not kb_ids:
                logger.warning("[WS] chat:send no valid knowledge base IDs found")
                return context_metadata, None

            # Retrieve and assemble RAG prompt
            rag_prompt = await retrieve_and_assemble_rag_prompt(
                query=payload.message,
                knowledge_base_ids=kb_ids,
                user_id=user_id,
                db=db,
            )

            if rag_prompt:
                logger.info(
                    f"[WS] chat:send RAG prompt assembled, length={len(rag_prompt)}"
                )
                # Return RAG prompt separately, do NOT modify payload.message
                return context_metadata, rag_prompt
            else:
                logger.info("[WS] chat:send RAG retrieved no chunks")
                return context_metadata, None

        except Exception as e:
            logger.error(f"[WS] chat:send RAG processing failed: {e}", exc_info=True)
            # Continue with original message if RAG fails
            return context_metadata, None

    def _extract_knowledge_base_ids(
        self, context_metadata: Optional[Dict]
    ) -> list[int]:
        """
        Extract knowledge base IDs from context metadata.

        Args:
            context_metadata: Context metadata dict containing contexts

        Returns:
            List of knowledge base IDs
        """
        kb_ids = []
        if not context_metadata:
            return kb_ids

        for ctx in context_metadata.get("contexts", []):
            if ctx.get("type") == "knowledge_base":
                try:
                    kb_data = ctx.get("data", {})
                    kb_id = kb_data.get("knowledge_id")

                    if isinstance(kb_id, int):
                        kb_ids.append(kb_id)
                    elif isinstance(kb_id, str) and kb_id.isdigit():
                        kb_ids.append(int(kb_id))
                    else:
                        logger.warning(
                            f"[WS] chat:send skipping non-numeric knowledge_id: {kb_id}"
                        )
                except (ValueError, AttributeError, KeyError) as e:
                    logger.warning(
                        f"[WS] chat:send failed to parse knowledge_id from context: {e}"
                    )
                    continue

        return kb_ids

    async def _process_context_and_rag(
        self,
        payload: ChatSendPayload,
        request: Any,
        should_trigger_ai: bool,
        user_id: int,
        db: Session,
    ) -> tuple[Optional[Dict], Optional[str]]:
        """
        Process context metadata and RAG based on chat version.

        This method handles RAG processing differently for chat v1 and chat_v2:
        - chat_v2 (enable_deep_thinking=True): Only extracts context metadata for tool-based RAG
        - chat v1 (enable_deep_thinking=False): Performs full RAG retrieval and prompt assembly

        Args:
            payload: Chat send payload
            request: Stream chat request
            should_trigger_ai: Whether AI should be triggered
            user_id: User ID
            db: Database session

        Returns:
            Tuple of (context_metadata dict, rag_prompt string or None)
        """
        if payload.enable_deep_thinking:
            # For chat_v2: only extract context metadata, no RAG retrieval
            # KnowledgeBaseTool will handle retrieval dynamically
            if payload.contexts and should_trigger_ai:
                context_metadata = {
                    "contexts": [
                        {
                            "type": ctx.type,
                            "data": ctx.data,
                        }
                        for ctx in payload.contexts
                    ],
                    "original_query": payload.message,
                }
                logger.info(
                    f"[WS] chat:send chat_v2 mode: extracted context metadata with {len(payload.contexts)} contexts"
                )
                return context_metadata, None
            return None, None
        else:
            # For chat v1: process RAG with retrieval and prompt assembly
            return await self._process_rag_if_needed(
                payload=payload,
                request=request,
                should_trigger_ai=should_trigger_ai,
                user_id=user_id,
                db=db,
            )

    @auto_task_context(ChatSendPayload, task_id_field="task_id")
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

        payload = data  # Already validated by decorator
        logger.info(
            f"[WS] chat:send payload parsed: team_id={payload.team_id}, task_id={payload.task_id}, message_len={len(payload.message) if payload.message else 0}"
        )

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
            from app.schemas.task import TaskCreate
            from app.services.adapters.task_kinds import task_kinds_service

            # Check if team supports direct chat
            supports_direct_chat = _should_use_direct_chat(db, team, user_id)
            logger.info(f"[WS] chat:send supports_direct_chat={supports_direct_chat}")

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
                title=payload.title,
                attachment_id=(
                    payload.attachment_ids[0]
                    if payload.attachment_ids
                    else payload.attachment_id
                ),
                enable_web_search=payload.enable_web_search,
                search_engine=payload.search_engine,
                enable_clarification=payload.enable_clarification,
                model_id=payload.force_override_bot_model,
                force_override_bot_model=payload.force_override_bot_model is not None,
                is_group_chat=payload.is_group_chat,
                # Repository info for code tasks
                git_url=payload.git_url,
                git_repo=payload.git_repo,
                git_repo_id=payload.git_repo_id,
                git_domain=payload.git_domain,
                branch_name=payload.branch_name,
            )
            logger.info(f"[WS] chat:send StreamChatRequest created")

            # Process context metadata and RAG based on chat version
            context_metadata, rag_prompt = await self._process_context_and_rag(
                payload=payload,
                request=request,
                should_trigger_ai=should_trigger_ai,
                user_id=user_id,
                db=db,
            )

            # Create task and subtasks
            # Use different methods based on supports_direct_chat:
            # - If supports_direct_chat is True: use _create_task_and_subtasks (async, for Chat Shell)
            # - If supports_direct_chat is False: use task_kinds_service.create_task_or_append (sync, for other shells)
            if supports_direct_chat:
                # Use _create_task_and_subtasks for direct chat (Chat Shell)
                logger.info(
                    f"[WS] chat:send calling _create_task_and_subtasks (supports_direct_chat=True)..."
                )
                result = await _create_task_and_subtasks(
                    db,
                    user,
                    team,
                    payload.message,  # Original message for storage
                    request,
                    payload.task_id,
                    should_trigger_ai=should_trigger_ai,
                    rag_prompt=rag_prompt,  # RAG prompt for AI inference
                )
                logger.info(
                    f"[WS] chat:send _create_task_and_subtasks returned: ai_triggered={result.get('ai_triggered')}, task_id={result.get('task').id if result.get('task') else None}"
                )

                task = result["task"]
                assistant_subtask = result["assistant_subtask"]
                user_subtask = result["user_subtask"]
                user_subtask_for_attachment = user_subtask
            else:
                # Use task_kinds_service.create_task_or_append for non-direct chat
                logger.info(
                    f"[WS] chat:send calling task_kinds_service.create_task_or_append (supports_direct_chat=False)..."
                )

                # Auto-detect task type based on git_url presence
                task_type = "code" if payload.git_url else "chat"

                # Build TaskCreate object
                task_create = TaskCreate(
                    title=payload.title,
                    team_id=payload.team_id,
                    git_url=payload.git_url or "",
                    git_repo=payload.git_repo or "",
                    git_repo_id=payload.git_repo_id or 0,
                    git_domain=payload.git_domain or "",
                    branch_name=payload.branch_name or "",
                    prompt=payload.message,
                    type="online",
                    task_type=task_type,
                    auto_delete_executor="false",
                    source="chat_shell",
                    model_id=payload.force_override_bot_model,
                    force_override_bot_model=payload.force_override_bot_model
                    is not None,
                )

                # Call create_task_or_append (synchronous method)
                task_dict = task_kinds_service.create_task_or_append(
                    db=db,
                    obj_in=task_create,
                    user=user,
                    task_id=payload.task_id,
                )

                # Get the task Kind object from database
                task = (
                    db.query(Kind)
                    .filter(
                        Kind.id == task_dict["id"],
                        Kind.kind == "Task",
                        Kind.is_active == True,
                    )
                    .first()
                )

                logger.info(
                    f"[WS] chat:send task_kinds_service.create_task_or_append returned: task_id={task_dict.get('id')}"
                )

                # Query the created subtasks from database
                # Get the latest USER subtask for this task
                user_subtask = (
                    db.query(Subtask)
                    .filter(
                        Subtask.task_id == task_dict["id"],
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
                            Subtask.task_id == task_dict["id"],
                            Subtask.role == SubtaskRole.ASSISTANT,
                        )
                        .order_by(Subtask.id.desc())
                        .first()
                    )

                user_subtask_for_attachment = user_subtask

            # Update user subtask with context metadata
            if context_metadata and user_subtask_for_attachment:
                try:
                    user_subtask_for_attachment.metadata = context_metadata
                    db.commit()
                    logger.info(
                        f"[WS] chat:send stored context metadata in subtask {user_subtask_for_attachment.id}"
                    )
                except Exception as e:
                    logger.exception(
                        f"[WS] chat:send failed to store context metadata: {e}"
                    )
                    db.rollback()

            # Link attachment to user subtask if provided
            # This is important for group chat history to include attachment content
            # Support both legacy attachment_id and new attachment_ids
            attachment_ids_to_link = []
            if payload.attachment_ids:
                attachment_ids_to_link = payload.attachment_ids
            elif payload.attachment_id:
                # Backward compatibility: convert single attachment_id to list
                attachment_ids_to_link = [payload.attachment_id]

            if attachment_ids_to_link and user_subtask_for_attachment:
                from app.services.attachment import attachment_service

                for attachment_id in attachment_ids_to_link:
                    attachment_service.link_attachment_to_subtask(
                        db=db,
                        attachment_id=attachment_id,
                        subtask_id=user_subtask_for_attachment.id,
                        user_id=user_id,
                    )
                    logger.info(
                        f"[WS] chat:send linked attachment {attachment_id} to subtask {user_subtask_for_attachment.id}"
                    )

            # Join task room
            task_room = f"task:{task.id}"
            await self.enter_room(sid, task_room)
            logger.info(f"[WS] chat:send joined task room: {task_room}")

            # Emit task:created event to user room for task list update
            from app.api.ws.events import ServerEvents
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter:
                team_crd = Team.model_validate(team.json)
                team_name = team_crd.metadata.name if team_crd.metadata else team.name
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

            # Broadcast user message to room (exclude sender)
            if user_subtask:
                await self._broadcast_user_message(
                    db=db,
                    user_subtask=user_subtask,
                    task_id=task.id,
                    message=payload.message,
                    user_id=user_id,
                    user_name=user_name,
                    attachment_id=(
                        payload.attachment_ids[0]
                        if payload.attachment_ids
                        else payload.attachment_id
                    ),
                    task_room=task_room,
                    skip_sid=sid,
                )
                logger.info(f"[WS] chat:send broadcasted user message to room")

            # Note: Model override metadata is already set during task creation
            # by _create_task_and_subtasks() or task_kinds_service.create_task_or_append()
            # No need to update it again here

            # Trigger AI response if needed (decoupled logic in ai_trigger.py)
            if should_trigger_ai and assistant_subtask:
                # Choose AI trigger based on enable_deep_thinking flag
                if payload.enable_deep_thinking:
                    logger.info("enable_deep_thinking is true, using chat_v2")
                    from app.services.chat_v2.ai_trigger import trigger_ai_response

                    # For chat_v2: extract knowledge base IDs for tool-based RAG
                    kb_ids = self._extract_knowledge_base_ids(context_metadata)
                    if kb_ids:
                        logger.info(
                            f"[WS] chat:send chat_v2 will use KnowledgeBaseTool with {len(kb_ids)} knowledge bases: {kb_ids}"
                        )

                    await trigger_ai_response(
                        task=task,
                        assistant_subtask=assistant_subtask,
                        team=team,
                        user=user,
                        message=payload.message,  # Original message
                        payload=payload,
                        task_room=task_room,
                        supports_direct_chat=supports_direct_chat,
                        namespace=self,
                        knowledge_base_ids=kb_ids,  # Pass KB IDs for tool-based RAG
                    )
                else:
                    logger.info("enable_deep_thinking is false, using chat")
                    from app.services.chat.ai_trigger import trigger_ai_response

                    # For chat v1: use RAG prompt if available
                    ai_message = rag_prompt or payload.message

                    await trigger_ai_response(
                        task=task,
                        assistant_subtask=assistant_subtask,
                        team=team,
                        user=user,
                        message=ai_message,  # Use RAG prompt for v1
                        payload=payload,
                        task_room=task_room,
                        supports_direct_chat=supports_direct_chat,
                        namespace=self,
                    )

            # Return unified response - same structure for all modes
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

        logger.info(
            f"[WS] Broadcasting user message to room: room={task_room}, "
            f"skip_sid={skip_sid}, message_id={user_subtask.message_id}, "
            f"sender_user_id={user_id}, sender_user_name={user_name}"
        )

        await self.emit(
            ServerEvents.CHAT_MESSAGE,
            {
                "subtask_id": user_subtask.id,
                "task_id": task_id,
                "message_id": user_subtask.message_id,
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

        logger.info(
            f"[WS] User message broadcasted successfully: "
            f"room={task_room}, message_id={user_subtask.message_id}, "
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

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            logger.error("[WS] chat:cancel error: Not authenticated")
            return {"error": "Not authenticated"}

        db = SessionLocal()
        try:
            # Verify ownership
            subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.id == payload.subtask_id,
                )
                .first()
            )

            if not subtask:
                logger.error(
                    f"[WS] chat:cancel error: Subtask not found subtask_id={payload.subtask_id} user_id={user_id}"
                )
                return {"error": "Subtask not found"}

            if subtask.status not in [SubtaskStatus.PENDING, SubtaskStatus.RUNNING]:
                logger.warning(
                    f"[WS] chat:cancel error: Cannot cancel subtask in {subtask.status.value} state"
                )
                return {
                    "error": f"Cannot cancel subtask in {subtask.status.value} state"
                }

            # Check if this is a Chat Shell task or Executor task based on shell_type
            # Shell type "Chat" uses session_manager (direct chat)
            # Other shell types (ClaudeCode, Agno, etc.) use executor_manager
            is_chat_shell = (
                payload.shell_type == "Chat" if payload.shell_type else False
            )

            logger.info(
                f"[WS] chat:cancel task_id={subtask.task_id}, shell_type={payload.shell_type}, is_chat_shell={is_chat_shell}"
            )

            if is_chat_shell:
                # For Chat Shell tasks, determine which session_manager to use
                # based on the version map created at stream registration
                stream_version = self._stream_versions.get(payload.subtask_id, "v1")

                if stream_version == "v2":
                    # Use chat_v2 session_manager
                    logger.info(
                        f"[WS] chat:cancel Using chat_v2 session_manager for subtask_id={payload.subtask_id}"
                    )
                    from app.services.chat_v2.storage import (
                        session_manager as session_manager_v2,
                    )

                    await session_manager_v2.cancel_stream(payload.subtask_id)
                else:
                    # Use chat session_manager (v1)
                    logger.info(
                        f"[WS] chat:cancel Using chat session_manager (v1) for subtask_id={payload.subtask_id}"
                    )
                    await session_manager.cancel_stream(payload.subtask_id)
            else:
                # For Executor tasks, call executor_manager API
                await call_executor_cancel(subtask.task_id)

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

            # Broadcast chat:cancelled event to all task room members via WebSocket
            # This ensures all group chat members see the streaming has stopped
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter:
                logger.info(
                    f"[WS] chat:cancel Broadcasting chat:cancelled event for task={subtask.task_id} subtask={payload.subtask_id}"
                )
                await ws_emitter.emit_chat_cancelled(
                    task_id=subtask.task_id, subtask_id=payload.subtask_id
                )

                # Also emit chat:done with message_id for proper message ordering
                # This ensures the cancelled message has message_id set for correct sorting
                await ws_emitter.emit_chat_done(
                    task_id=subtask.task_id,
                    subtask_id=payload.subtask_id,
                    offset=(
                        len(payload.partial_content) if payload.partial_content else 0
                    ),
                    result=subtask.result or {},
                    message_id=subtask.message_id,
                )
            else:
                logger.warning(
                    f"[WS] chat:cancel WebSocket emitter not available, cannot broadcast events"
                )

            # Notify group chat members about the status change
            # This ensures all members see the streaming has stopped and status updated
            if task:
                # Import helper function from chat.py
                from app.api.endpoints.adapter.chat import (
                    _notify_group_members_task_updated,
                )

                await _notify_group_members_task_updated(
                    db=db, task=task, sender_user_id=user_id
                )

            return {"success": True}

        except Exception as e:
            logger.error(f"[WS] chat:cancel exception: {e}", exc_info=True)
            db.rollback()
            return {"error": f"Internal server error: {str(e)}"}
        finally:
            db.close()

    def _fetch_retry_context(
        self, db, payload: "ChatRetryPayload"
    ) -> tuple[
        Optional["Subtask"], Optional["Kind"], Optional["Kind"], Optional["Subtask"]
    ]:
        """
        Fetch all required database entities for retry operation in a single optimized query.

        Args:
            db: Database session
            payload: Retry payload with task_id and subtask_id

        Returns:
            Tuple of (failed_ai_subtask, task, team, user_subtask)
        """
        from sqlalchemy.orm import aliased, joinedload

        TaskKind = aliased(Kind)
        TeamKind = aliased(Kind)

        # Optimized query: fetch failed_ai_subtask, task, and team in one go
        query_result = (
            db.query(
                Subtask,  # failed_ai_subtask
                TaskKind,  # task
                TeamKind,  # team
            )
            .select_from(Subtask)  # Explicitly specify the main table
            .outerjoin(
                TaskKind,
                and_(
                    TaskKind.id == payload.task_id,
                    TaskKind.kind == "Task",
                    TaskKind.is_active,
                ),
            )
            .outerjoin(
                TeamKind,
                and_(
                    TeamKind.id == Subtask.team_id,
                    TeamKind.kind == "Team",
                    TeamKind.is_active,
                ),
            )
            .filter(
                Subtask.id == payload.subtask_id,
                Subtask.task_id == payload.task_id,
                Subtask.role == SubtaskRole.ASSISTANT,
            )
            .first()
        )

        if not query_result:
            return None, None, None, None

        failed_ai_subtask, task, team = query_result

        # Fetch user subtask separately
        # Key insight: parent_id stores message_id (not subtask.id) throughout the system
        # Both in chat.py and task_kinds.py, parent_id is always set to message_id
        user_subtask = None
        if failed_ai_subtask and failed_ai_subtask.parent_id:
            # Use parent_id as message_id to find the triggering USER subtask
            # This works for both single chat and group chat
            user_subtask = (
                db.query(Subtask)
                .options(joinedload(Subtask.attachments))  # Preload attachments
                .filter(
                    Subtask.task_id == failed_ai_subtask.task_id,
                    Subtask.message_id == failed_ai_subtask.parent_id,
                    Subtask.role == SubtaskRole.USER,
                )
                .first()
            )
            if user_subtask:
                logger.info(
                    f"[WS] chat:retry found user_subtask via parent_id as message_id: "
                    f"id={user_subtask.id}, message_id={user_subtask.message_id}, "
                    f"prompt={user_subtask.prompt[:50] if user_subtask.prompt else ''}..."
                )
            else:
                logger.warning(
                    f"[WS] chat:retry could not find USER subtask with message_id={failed_ai_subtask.parent_id}"
                )

        return failed_ai_subtask, task, team, user_subtask

    def _reset_subtask_for_retry(self, db, subtask: "Subtask") -> None:
        """
        Reset a failed subtask to PENDING status for retry.

        Args:
            db: Database session
            subtask: The subtask to reset

        Raises:
            Exception: If database commit fails
        """
        subtask.status = SubtaskStatus.PENDING
        subtask.progress = 0
        subtask.error_message = ""
        subtask.result = None
        subtask.updated_at = datetime.now()

        try:
            db.commit()
            db.refresh(subtask)
        except Exception as e:
            logger.error(f"[WS] chat:retry failed to reset subtask: {e}", exc_info=True)
            db.rollback()
            raise  # Re-raise to prevent downstream processing

        logger.info(
            f"[WS] chat:retry reset subtask to PENDING: id={subtask.id}, message_id={subtask.message_id}"
        )

    def _extract_model_override_info(self, task: "Kind") -> tuple[Optional[str], bool]:
        """
        Extract model override information from task metadata.

        Reading Model Override Metadata:
        - Primary source: task.json.metadata.labels (set by on_chat_send when user overrides model)
        - Fallback source: task.json.spec (for compatibility with other shells)

        Args:
            task: The task containing metadata

        Returns:
            Tuple of (model_id, force_override)
        """
        task_spec_dict = task.json.get("spec", {})
        task_metadata = task.json.get("metadata", {})
        task_labels = task_metadata.get("labels", {})

        # Try to get model info from metadata.labels first (for direct chat)
        model_id = task_labels.get("modelId") or task_spec_dict.get("modelId")
        force_override = (
            task_labels.get("forceOverrideBotModel") == "true"
            or task_spec_dict.get("forceOverrideBotModel") == "true"
        )

        logger.info(
            f"[WS] chat:retry extracted model info: model_id={model_id}, force_override={force_override}"
        )

        return model_id, force_override

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

        db = SessionLocal()
        try:
            # Fetch all required entities using optimized query
            failed_ai_subtask, task, team, user_subtask = self._fetch_retry_context(
                db, payload
            )

            # Validate entities exist
            if not failed_ai_subtask:
                logger.error(
                    f"[WS] chat:retry error: AI subtask not found id={payload.subtask_id}"
                )
                return {"error": "AI subtask not found"}

            if not task:
                logger.error(
                    f"[WS] chat:retry error: Task not found id={payload.task_id}"
                )
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

            logger.info(
                f"[WS] chat:retry found failed_ai_subtask: id={failed_ai_subtask.id}, "
                f"message_id={failed_ai_subtask.message_id}, "
                f"parent_id={failed_ai_subtask.parent_id}, "
                f"status={failed_ai_subtask.status.value}"
            )
            logger.info(
                f"[WS] chat:retry found user_subtask: id={user_subtask.id}, prompt={user_subtask.prompt[:50] if user_subtask.prompt else ''}..."
            )

            # Reset the failed AI subtask to PENDING status
            self._reset_subtask_for_retry(db, failed_ai_subtask)

            # Trigger AI response
            from app.api.endpoints.adapter.chat import _should_use_direct_chat
            from app.models.user import User
            from app.services.chat.ai_trigger import trigger_ai_response

            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.error(f"[WS] chat:retry error: User not found id={user_id}")
                return {"error": "User not found"}

            supports_direct_chat = _should_use_direct_chat(db, team, user_id)
            logger.info(f"[WS] chat:retry supports_direct_chat={supports_direct_chat}")

            # Determine model to use for retry:
            # Use the SAME logic as normal message sending (ChatSendPayload handling):
            # 1. If use_model_override is True:
            #    - If force_override_bot_model is provided: use that specific model
            #    - If force_override_bot_model is None/empty: use bot's default model
            # 2. If use_model_override is False: fall back to task metadata model
            #
            # This matches the normal chat flow where:
            # - model_id = undefined (None) means "use bot's default"
            # - force_override_bot_model = True means "apply user's selection"
            # - force_override_bot_model = False means "use task metadata"
            model_id = None
            model_type = None

            if payload.use_model_override:
                # User explicitly selected a model (including "Default Model")
                # Use the model from payload if provided, otherwise use bot's default (None)
                model_id = payload.force_override_bot_model
                model_type = payload.force_override_bot_model_type
                logger.info(
                    f"[WS] chat:retry use_model_override=True, using model from payload: "
                    f"model_id={model_id}, model_type={model_type}"
                )
            else:
                # User did not override model selection, fall back to task metadata
                # This preserves the original model used when the task was created
                task_model_id, force_override = self._extract_model_override_info(task)
                if force_override and task_model_id:
                    model_id = task_model_id
                    logger.info(
                        f"[WS] chat:retry use_model_override=False, using model from task metadata: "
                        f"model_id={model_id}"
                    )
                else:
                    logger.info(
                        f"[WS] chat:retry use_model_override=False, no task metadata model, "
                        f"will use bot's default model"
                    )

            # Build payload for AI trigger (reuse user message content and model override)
            # If model_id exists, use it; otherwise, use None to let the bot use its default model
            from app.api.ws.events import ChatSendPayload

            # Get attachment from user_subtask if exists
            attachment_id = None
            if user_subtask.attachments:
                # Use the first attachment (chat messages typically have one attachment)
                attachment_id = user_subtask.attachments[0].id
                logger.info(
                    f"[WS] chat:retry found attachment: id={attachment_id}, "
                    f"filename={user_subtask.attachments[0].original_filename}"
                )

            retry_payload = ChatSendPayload(
                task_id=payload.task_id,
                team_id=team.id,
                message=user_subtask.prompt or "",
                attachment_id=attachment_id,
                force_override_bot_model=model_id,
                force_override_bot_model_type=model_type,
                is_group_chat=False,
            )

            # Trigger AI response
            task_room = f"task:{payload.task_id}"
            await trigger_ai_response(
                task=task,
                assistant_subtask=failed_ai_subtask,  # Reuse the same subtask
                team=team,
                user=user,
                message=user_subtask.prompt or "",
                payload=retry_payload,
                task_room=task_room,
                supports_direct_chat=supports_direct_chat,
                namespace=self,
            )

            logger.info(
                f"[WS] chat:retry AI response triggered for subtask_id={failed_ai_subtask.id}"
            )

            return {"success": True}

        except ValueError as e:
            # Validation errors, data parsing errors
            logger.error(f"[WS] chat:retry validation error: {e}", exc_info=True)
            db.rollback()

            # Broadcast error to all clients in task room
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter and payload.subtask_id:
                await ws_emitter.emit_chat_error(
                    task_id=payload.task_id,
                    subtask_id=payload.subtask_id,
                    error=f"Invalid data: {str(e)}",
                    message_id=None,  # Will use subtask's message_id
                )

            return {"error": f"Invalid data: {str(e)}"}
        except PermissionError as e:
            # Permission/access errors
            logger.error(f"[WS] chat:retry permission error: {e}", exc_info=True)
            db.rollback()

            # Broadcast error to all clients in task room
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter and payload.subtask_id:
                await ws_emitter.emit_chat_error(
                    task_id=payload.task_id,
                    subtask_id=payload.subtask_id,
                    error=f"Access denied: {str(e)}",
                    message_id=None,
                )

            return {"error": f"Access denied: {str(e)}"}
        except Exception as e:
            # Catch SQLAlchemy errors and other unexpected exceptions
            from sqlalchemy.exc import SQLAlchemyError

            logger.error(f"[WS] chat:retry exception: {e}", exc_info=True)
            db.rollback()

            # Broadcast error to all clients in task room
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            error_msg = (
                "Database error occurred"
                if isinstance(e, SQLAlchemyError)
                else f"Internal server error: {str(e)}"
            )
            if ws_emitter and payload.subtask_id:
                await ws_emitter.emit_chat_error(
                    task_id=payload.task_id,
                    subtask_id=payload.subtask_id,
                    error=error_msg,
                    message_id=None,
                )

            if isinstance(e, SQLAlchemyError):
                return {"error": "Database error occurred"}
            return {"error": f"Internal server error: {str(e)}"}
        finally:
            db.close()

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
