# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified task dispatcher for execution.

Dispatches tasks to execution services based on routing configuration.

All external code should use the unified `dispatch` method with an appropriate
emitter. Different emitter types support different use cases:
- WebSocketResultEmitter: Push events to WebSocket clients
- SSEResultEmitter: Queue-based emitter for streaming responses
- SubscriptionResultEmitter: For subscription task execution

For SSE mode (Chat shell), uses OpenAI AsyncClient to consume the
OpenAI Responses API compatible endpoint.
"""

import asyncio
import logging
from typing import Any, List, Optional

from sqlalchemy.orm import Session

from app.core.async_utils import run_in_main_loop
from app.db.session import SessionLocal
from app.models.subtask import Subtask
from app.services.task_status import extract_task_error
from app.stores.tasks import subtask_store, task_store
from shared.models import (
    ExecutionEvent,
    ExecutionRequest,
    OpenAIRequestConverter,
)
from shared.telemetry.decorators import trace_async
from shared.utils.http_client import traced_async_client

from .attachment_sync import apply_attachment_sync_response, sync_executor_attachments
from .chat_shell_sse import cancel_chat_shell, dispatch_sse, notify_chat_shell_error
from .emitters import (
    ResultEmitter,
    ResultEmitterFactory,
    StatusUpdatingEmitter,
    WebSocketResultEmitter,
)
from .executor_health import executor_pod_missing
from .git_credentials import build_device_git_execution_payload
from .inprocess_chat import dispatch_inprocess_chat
from .polling_dispatcher import dispatch_polling
from .recovery_service import recovery_service
from .response_parser import ResponsesAPIEventParser
from .router import CommunicationMode, ExecutionRouter, ExecutionTarget

logger = logging.getLogger(__name__)

_FRONTEND_ERROR_EMITTED_ATTR = "_frontend_error_emitted"


class ExecutionDispatcher:
    """Unified task dispatcher.

    Core responsibilities:
    1. Use ExecutionRouter to determine target
    2. Send request based on communication mode
    3. Unified event handling via ResultEmitter

    Design principles:
    - Does not know what the execution service is
    - Only knows communication mode and target address
    - Uses ResultEmitter for all event emission
    - All external code should use the unified `dispatch` method
    """

    def __init__(self):
        """Initialize the execution dispatcher."""
        self.router = ExecutionRouter()
        self.http_client = traced_async_client(timeout=300.0)
        self.event_parser = ResponsesAPIEventParser()

    async def dispatch(
        self,
        request: ExecutionRequest,
        device_id: Optional[str] = None,
        emitter: Optional[ResultEmitter] = None,
    ) -> None:
        """Unified dispatch entry point for task execution.

        This is the ONLY public method for dispatching tasks. All external code
        should use this method with an appropriate emitter.

        For different use cases, pass different emitter types:
        - WebSocketResultEmitter: Events pushed to WebSocket (default)
        - SSEResultEmitter: Use emitter.stream() to iterate events
        - SubscriptionResultEmitter: For subscription task callbacks

        Example usage with SSEResultEmitter for streaming:
            emitter = SSEResultEmitter(task_id, subtask_id)
            task = asyncio.create_task(dispatcher.dispatch(request, emitter=emitter))
            async for event in emitter.stream():
                yield process_event(event)
            await task

        Example usage with SSEResultEmitter for sync (collect all):
            emitter = SSEResultEmitter(task_id, subtask_id)
            task = asyncio.create_task(dispatcher.dispatch(request, emitter=emitter))
            content, final_event = await emitter.collect()
            await task

        Args:
            request: Unified execution request
            device_id: Optional device ID - uses WebSocket mode when specified
            emitter: Optional custom emitter, defaults to WebSocketResultEmitter
        """
        wrapped_emitter = None
        try:
            if device_id:
                user_id = request.user.get("id") if request.user else None
                if not isinstance(user_id, int):
                    raise ValueError("Device dispatch requires an authenticated user")
            await self._recover_executor_if_needed(request, device_id=device_id)

            # Route to execution target
            target = self.router.route(
                request,
                await self._resolve_device_route_id(request, device_id),
            )
            logger.info(
                f"[ExecutionDispatcher] Routed: task_id={request.task_id}, "
                f"subtask_id={request.subtask_id}, device_id={device_id} -> {target}"
            )
            # Create default emitter if not provided
            if emitter is None:
                # Extract team info from request for task:created event
                team_id = None
                team_name = None
                is_group_chat = False
                if request.bot and len(request.bot) > 0:
                    team_id = request.bot[0].get("team_id")
                    team_name = request.bot[0].get("team_name")
                    is_group_chat = request.bot[0].get("is_group_chat", False)

                # Extract task title from request
                task_title = request.task_title

                emitter = WebSocketResultEmitter(
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    user_id=request.user.get("id") if request.user else None,
                    team_id=team_id,
                    team_name=team_name,
                    task_title=task_title,
                    is_group_chat=is_group_chat,
                    project_id=request.project_id,
                )

            # Wrap emitter with StatusUpdatingEmitter for unified status updates
            # This ensures task status is updated to COMPLETED/FAILED/CANCELLED
            # when terminal events are received, regardless of execution mode
            wrapped_emitter = StatusUpdatingEmitter(
                wrapped=emitter,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
            )

            logger.info(
                f"[ExecutionDispatcher] Dispatching: task_id={request.task_id}, "
                f"subtask_id={request.subtask_id}, mode={target.mode.value}"
            )

            # Update subtask status to RUNNING before dispatching
            # This applies to all execution modes (SSE, WebSocket, HTTP+Callback)
            await self._update_subtask_to_running(request.subtask_id)

            if target.mode == CommunicationMode.SSE:
                await self._dispatch_sse(request, target, wrapped_emitter)
            elif target.mode == CommunicationMode.WEBSOCKET:
                await self._dispatch_websocket(request, target, wrapped_emitter)
            elif target.mode == CommunicationMode.POLLING:
                await self._dispatch_polling(request, target, wrapped_emitter)
            elif target.mode == CommunicationMode.INPROCESS:
                await self._dispatch_inprocess(request, target, wrapped_emitter)
            else:
                await self._dispatch_http_callback(request, target, wrapped_emitter)
        except asyncio.CancelledError:
            # A cancelled SSE owner has already closed its stream. Persist the
            # terminal state before closing the emitter, including lease loss.
            # Remote dispatch modes retain their executor-owned lifecycle.
            if wrapped_emitter is not None and target.mode == CommunicationMode.SSE:
                logger.info(
                    "[ExecutionDispatcher] SSE dispatch task cancelled: "
                    "task_id=%s, subtask_id=%s",
                    request.task_id,
                    request.subtask_id,
                )
                try:
                    await wrapped_emitter.emit_cancelled(
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                    )
                except Exception:
                    logger.exception(
                        "[ExecutionDispatcher] Failed to finalize cancelled SSE "
                        "dispatch: task_id=%s, subtask_id=%s",
                        request.task_id,
                        request.subtask_id,
                    )
            raise
        except Exception as e:
            logger.exception(
                f"[ExecutionDispatcher] Dispatch error: task_id={request.task_id}, "
                f"subtask_id={request.subtask_id}, error={e}"
            )
            # Try to emit error to frontend if emitter is available
            if wrapped_emitter is not None:
                try:
                    from shared.utils.error_classifier import (
                        classify_error,
                        format_error_message,
                    )

                    error_code = classify_error(e)
                    await wrapped_emitter.emit_error(
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                        error=format_error_message(e),
                        error_code=error_code,
                    )
                    setattr(e, _FRONTEND_ERROR_EMITTED_ATTR, True)
                except Exception as emit_error:
                    logger.error(
                        f"[ExecutionDispatcher] Failed to emit error: {emit_error}"
                    )
            # Re-raise the exception so the caller knows dispatch failed
            raise
        finally:
            if wrapped_emitter is not None:
                try:
                    await wrapped_emitter.close()
                except Exception as close_error:
                    logger.error(
                        f"[ExecutionDispatcher] Failed to close emitter: {close_error}"
                    )

    async def _recover_executor_if_needed(
        self,
        request: ExecutionRequest,
        device_id: Optional[str] = None,
    ) -> None:
        """Recover executor state for deleted runtime instances before dispatching."""
        shell_type = self._get_shell_type(request)
        if shell_type not in {"ClaudeCode", "Agno", "CodeX", "Codex"}:
            return
        if device_id and self._has_fork_workspace_archive(request):
            return

        db = SessionLocal()
        try:
            subtask = subtask_store.get_by_id(db, subtask_id=request.subtask_id)
            if not subtask:
                return

            # Save reference to current subtask for later update
            current_subtask = subtask

            restore_fork_workspace = self._has_fork_workspace_archive(request)
            executor_missing = False
            if not subtask.executor_deleted_at and not restore_fork_workspace:
                executor_missing = await self._mark_missing_executor_deleted(
                    db, subtask
                )
                if not executor_missing:
                    return

            task = task_store.get_by_id(db, task_id=request.task_id)
            if not task:
                raise RuntimeError(
                    f"Task {request.task_id} not found for executor recovery"
                )

            logger.info(
                "[ExecutionDispatcher] Recovering executor workspace: "
                "task_id=%s, subtask_id=%s, executor=%s, reason=%s",
                request.task_id,
                request.subtask_id,
                subtask.executor_name,
                (
                    "fork_workspace_archive"
                    if restore_fork_workspace
                    else (
                        "missing_executor" if executor_missing else "deleted_executor"
                    )
                ),
            )

            recovered_info = await recovery_service.recover(
                db=db,
                subtask=subtask,
                task=task,
                request=request,
            )
            if not recovered_info:
                subtask_error = getattr(subtask, "error_message", None)
                error_message = (
                    subtask_error
                    if isinstance(subtask_error, str) and subtask_error.strip()
                    else extract_task_error(task)
                )
                if not error_message:
                    error_message = (
                        f"Failed to recover executor for subtask {request.subtask_id}"
                    )
                raise RuntimeError(error_message)

            # Update the current subtask to reflect the recovered executor.
            subtask_store.update_fields(
                db,
                subtask=current_subtask,
                executor_name=recovered_info["executor_name"],
                executor_namespace=recovered_info["executor_namespace"],
                executor_deleted_at=False,
            )
            db.commit()

            request.executor_name = recovered_info["executor_name"]
            request.executor_namespace = recovered_info["executor_namespace"]
            logger.info(
                "[ExecutionDispatcher] Recovered executor: "
                "task_id=%s, current_subtask_id=%s, executor=%s/%s",
                request.task_id,
                current_subtask.id,
                request.executor_namespace,
                request.executor_name,
            )
        finally:
            db.close()

    async def _mark_missing_executor_deleted(
        self,
        db: Session,
        subtask: Subtask,
    ) -> bool:
        """Persist ``executor_deleted_at`` when the bound executor vanished.

        The flag is normally set by the executor cleanup path. Pods can also
        disappear outside of it (eviction, node drain, manual delete); without
        this check dispatch would reuse the stale executor name and fail
        permanently instead of restoring the workspace.

        Returns:
            True when the executor is confirmed gone and marked for recovery.
        """
        executor_name = (subtask.executor_name or "").strip()
        if not executor_name or executor_name.startswith("device-"):
            return False
        if not await executor_pod_missing(executor_name, subtask.executor_namespace):
            return False

        logger.info(
            "[ExecutionDispatcher] Executor unavailable, marking deleted: "
            "task_id=%s, subtask_id=%s, executor=%s/%s",
            subtask.task_id,
            subtask.id,
            subtask.executor_namespace,
            executor_name,
        )
        subtask_store.update_fields(db, subtask=subtask, executor_deleted_at=True)
        db.commit()
        return True

    @staticmethod
    def _has_fork_workspace_archive(request: ExecutionRequest) -> bool:
        fork_runtime = getattr(request, "fork_runtime", None)
        if not isinstance(fork_runtime, dict):
            return False
        workspace_archive = fork_runtime.get("workspaceArchive")
        if not isinstance(workspace_archive, dict):
            return False
        storage_key = workspace_archive.get("storageKey")
        return isinstance(storage_key, str) and bool(storage_key.strip())

    async def _update_subtask_to_running(self, subtask_id: int) -> None:
        """Update subtask status to RUNNING in database.

        This is called before dispatching to any executor type to ensure
        the subtask status is updated to RUNNING at the start of execution.

        Args:
            subtask_id: Subtask ID to update
        """
        from app.services.chat.storage.db import db_handler

        try:
            await db_handler.update_subtask_status(subtask_id, "RUNNING")
            logger.info(
                f"[ExecutionDispatcher] Updated subtask {subtask_id} status to RUNNING"
            )
        except Exception as e:
            logger.error(
                f"[ExecutionDispatcher] Failed to update subtask {subtask_id} to RUNNING: {e}"
            )

    async def _resolve_device_route_id(
        self, request: ExecutionRequest, device_id: Optional[str]
    ) -> Optional[str]:
        """Resolve a logical App device to its registered Socket.IO route."""
        if (
            not device_id
            or not request.user
            or request.user.get("id") is None
            or self._has_fork_workspace_archive(request)
        ):
            return device_id

        from app.services.device.identity import device_connection_route_id
        from app.services.device_service import device_service

        def resolve() -> Optional[str]:
            with SessionLocal() as db:
                device = device_service.get_device_by_device_id(
                    db,
                    user_id=request.user["id"],
                    device_id=device_id,
                )
                return device_connection_route_id(device) if device else device_id

        return await asyncio.to_thread(resolve)

    async def _set_subtask_executor(
        self,
        subtask_id: int,
        device_id: str,
        user_id: Optional[int],
    ) -> None:
        """Set executor info on subtask for device-mode dispatch.

        This is required so that subsequent progress/result events from the device
        pass the ownership check in device_namespace._update_subtask_progress().

        Args:
            subtask_id: Subtask ID to update
            device_id: Device ID
            user_id: User ID
        """
        db = SessionLocal()
        try:
            subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
            if subtask:
                subtask_store.update_executor_info(
                    db,
                    subtask=subtask,
                    executor_name=f"device-{device_id}",
                    executor_namespace=f"user-{user_id}" if user_id else "",
                )
                db.commit()
                logger.info(
                    f"[ExecutionDispatcher] Set executor on subtask {subtask_id}: "
                    f"executor_name=device-{device_id}"
                )
        except Exception as e:
            logger.error(
                f"[ExecutionDispatcher] Failed to set executor on subtask {subtask_id}: {e}"
            )
            db.rollback()
        finally:
            db.close()

    def supports_streaming(self, request: ExecutionRequest) -> bool:
        """Check if the request supports streaming.

        Only SSE mode supports streaming responses.

        Args:
            request: Execution request

        Returns:
            True if streaming is supported
        """
        target = self.router.route(request, device_id=None)
        return target.mode == CommunicationMode.SSE

    @staticmethod
    def _get_shell_type(request: ExecutionRequest) -> str:
        """Extract shell_type from execution request.

        Args:
            request: Execution request

        Returns:
            Shell type string (e.g., "ClaudeCode", "Chat", "Agno")
        """
        if request.bot and len(request.bot) > 0:
            return request.bot[0].get("shell_type", "Chat")
        return "Chat"

    @staticmethod
    def _get_bot_name(request: ExecutionRequest) -> Optional[str]:
        """Extract the current bot name from an execution request."""
        request_bot_name = getattr(request, "bot_name", "")
        if isinstance(request_bot_name, str) and request_bot_name.strip():
            return request_bot_name

        bots = getattr(request, "bot", None)
        if isinstance(bots, list) and bots:
            first_bot = bots[0]
            if isinstance(first_bot, dict):
                bot_name = first_bot.get("name")
                if isinstance(bot_name, str) and bot_name.strip():
                    return bot_name

        return None

    @classmethod
    def _build_start_event_data(
        cls, request: ExecutionRequest, shell_type: Optional[str] = None
    ) -> dict[str, str]:
        """Build common data for chat:start events."""
        data = {"shell_type": shell_type or cls._get_shell_type(request)}
        bot_name = cls._get_bot_name(request)
        if bot_name:
            data["bot_name"] = bot_name
        return data

    async def dispatch_with_composite(
        self,
        request: ExecutionRequest,
        emitter_configs: List[dict],
        device_id: Optional[str] = None,
    ) -> None:
        """Dispatch task with composite emitter.

        Supports sending events to multiple targets simultaneously.

        Args:
            request: Execution request
            emitter_configs: List of emitter configurations
            device_id: Optional device ID
        """
        emitter = ResultEmitterFactory.create_composite(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            emitter_configs=emitter_configs,
        )

        await self.dispatch(request, device_id, emitter)

    @trace_async(
        span_name="dispatcher.dispatch_sse",
        tracer_name="backend.execution",
        extract_attributes=lambda self, request, target, emitter: {
            "task.id": str(request.task_id),
            "subtask.id": str(request.subtask_id),
            "target.url": target.url,
            "shell.type": self._get_shell_type(request),
        },
    )
    async def _dispatch_sse(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        await dispatch_sse(
            request,
            target,
            emitter,
            self.event_parser,
            self._build_start_event_data(request),
        )

    async def _dispatch_polling(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via polling mode for long-running async APIs.

        Delegates to polling_dispatcher module which calls Gemini API directly.
        """
        await dispatch_polling(request, target, emitter)

    async def _dispatch_websocket(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via WebSocket - passive request with long connection.

        Executor has already connected to Backend, Backend pushes task to specified room.

        Args:
            request: Execution request
            target: Execution target configuration
            emitter: Result emitter for event emission
        """
        from app.core.socketio import get_sio

        sio = get_sio()

        # Set executor_name on subtask so progress/result events pass ownership check
        # target.room format: "device:{user_id}:{device_id}"
        if target.room:
            parts = target.room.split(":")
            if len(parts) == 3 and parts[0] == "device":
                device_id = parts[2]
                user_id = request.user.get("id") if request.user else None
                await self._set_subtask_executor(request.subtask_id, device_id, user_id)

        # Send START event to frontend (creates AI message placeholder)
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            data=self._build_start_event_data(request),
        )

        # Send task to specified room
        payload = build_device_git_execution_payload(request)
        await self._emit_socketio_in_main_loop(sio, target, payload)

        logger.info(
            f"[ExecutionDispatcher] WebSocket dispatch: "
            f"namespace={target.namespace}, room={target.room}, event={target.event}"
        )

        # In WebSocket mode, subsequent events are handled by DeviceNamespace's
        # on_task_progress/on_task_complete
        # No need to wait for response here

    async def _emit_socketio_in_main_loop(
        self,
        sio: Any,
        target: ExecutionTarget,
        payload: dict,
    ) -> None:
        """Emit Socket.IO events from the main application loop.

        Socket.IO and its Redis manager are owned by the main app loop. Subscription
        device execution runs in a background thread with a separate event loop, so
        direct awaits against `sio.emit()` can fail with cross-loop Future errors.
        """

        async def _emit() -> None:
            from app.services.execution.device_socketio import (
                publish_device_execution,
            )

            publish_device_execution(
                event=target.event,
                namespace=target.namespace or "/",
                room=target.room or "",
                payload=payload,
            )

        await run_in_main_loop(_emit)

    async def _dispatch_inprocess(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via in-process execution (standalone mode).

        Directly executes Chat tasks within the Backend process when chat_shell
        package mode is enabled. ClaudeCode/Agno are executed by the Rust
        executor through HTTP callback mode.

        Args:
            request: Execution request
            target: Execution target configuration (not used, kept for interface consistency)
            emitter: Result emitter for event emission
        """
        shell_type = self._get_shell_type(request)

        logger.info(
            f"[ExecutionDispatcher] In-process dispatch: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}, "
            f"shell_type={shell_type}"
        )

        # Send START event to frontend (creates AI message placeholder)
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            data=self._build_start_event_data(request, shell_type),
        )

        if shell_type == "Chat":
            # Use chat_shell module for Chat type
            await dispatch_inprocess_chat(request, emitter, self.event_parser)
        else:
            raise RuntimeError(
                "Non-Chat standalone execution must be routed to the Rust "
                "local executor device"
            )

        logger.info(
            f"[ExecutionDispatcher] In-process dispatch completed: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

    async def _dispatch_http_callback(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        emitter: ResultEmitter,
    ) -> None:
        """Dispatch task via HTTP+Callback using OpenAI background mode.

        Uses OpenAI Responses API background mode (non-streaming).
        Backend sends HTTP request with background=true, executor executes
        asynchronously and returns result via callback.

        Args:
            request: Execution request
            target: Execution target configuration
            emitter: Result emitter for event emission
        """
        # OpenAI client appends /responses to base_url, so we need to include /v1
        # e.g., base_url=http://127.0.0.1:8001/v1 -> POST http://127.0.0.1:8001/v1/responses
        base_url = f"{target.url}/v1"

        logger.info(
            f"[ExecutionDispatcher] HTTP+Callback dispatch via OpenAI client: "
            f"base_url={base_url}"
        )

        await self._sync_attachments_before_executor_dispatch(request)

        # Convert ExecutionRequest to OpenAI format
        openai_request = OpenAIRequestConverter.from_execution_request(request)

        # Get tools from openai_request (includes MCP servers converted to tools)
        tools = openai_request.get("tools", [])

        logger.info(
            f"[ExecutionDispatcher] Sending OpenAI background request: "
            f"base_url={base_url}, model={openai_request.get('model')}, "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

        # Lazy import OpenAI SDK for memory optimization
        from openai import AsyncOpenAI

        # Create OpenAI client pointing to executor-manager
        async with AsyncOpenAI(
            base_url=base_url,
            api_key="dummy",  # Not used by executor_manager but required by client
            timeout=300.0,
            max_retries=0,  # Queue submission is not idempotent; never replay it.
        ) as client:

            # Send request using OpenAI client with background mode
            # background=true: Execute asynchronously, result via callback
            # stream=false: No streaming, just return queued status
            response = await client.responses.create(
                model=openai_request.get("model", ""),
                input=openai_request.get("input", ""),
                instructions=openai_request.get("instructions"),
                tools=tools if tools else None,
                stream=False,
                extra_body={
                    "background": True,
                    "metadata": openai_request.get("metadata", {}),
                    "model_config": openai_request.get("model_config", {}),
                },
            )

        logger.info(
            f"[ExecutionDispatcher] HTTP+Callback dispatch (OpenAI background): "
            f"response_id={getattr(response, 'id', 'N/A')}"
        )

        # In HTTP+Callback mode, subsequent events are handled via /callback API
        # Only send START event here
        await emitter.emit_start(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
            data=self._build_start_event_data(request),
        )

    async def _sync_attachments_before_executor_dispatch(
        self, request: ExecutionRequest
    ) -> None:
        """Prepare attachments in executor runtime before formal dispatch."""
        if not request.attachments:
            return
        shell_type = self._get_shell_type(request)
        if shell_type not in {"ClaudeCode", "Agno", "CodeX", "Codex"}:
            return

        logger.info(
            "[ExecutionDispatcher] Syncing attachments before executor dispatch: "
            "task_id=%s, subtask_id=%s, shell_type=%s, attachments=%d",
            request.task_id,
            request.subtask_id,
            shell_type,
            len(request.attachments),
        )
        sync_response = await sync_executor_attachments(request)
        apply_attachment_sync_response(request, sync_response)
        logger.info(
            "[ExecutionDispatcher] Attachment sync applied: task_id=%s, "
            "subtask_id=%s, executor_name=%s, success_count=%d, failed_count=%d",
            request.task_id,
            request.subtask_id,
            request.executor_name,
            sync_response.success_count,
            sync_response.failed_count,
        )

    def parse_callback_event(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int],
        event_type: str,
        data: dict,
    ) -> Optional[ExecutionEvent]:
        """Parse callback event data using shared parser.

        This method is exposed for use by HTTP callback handlers.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
            event_type: Event type string
            data: Event data dictionary

        Returns:
            Parsed ExecutionEvent or None if event should be skipped
        """
        return self.event_parser.parse(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            event_type=event_type,
            data=data,
        )

    async def cancel(
        self,
        request: ExecutionRequest,
        device_id: Optional[str] = None,
    ) -> bool:
        """Cancel task.

        Args:
            request: Execution request
            device_id: Optional device ID

        Returns:
            True if cancel request was sent successfully
        """
        target = self.router.route(request, device_id)

        if target.mode == CommunicationMode.SSE:
            return await cancel_chat_shell(request.subtask_id)
        elif target.mode == CommunicationMode.WEBSOCKET:
            return await self._cancel_websocket(request, target)
        elif target.mode == CommunicationMode.POLLING:
            return await cancel_chat_shell(request.subtask_id)
        elif target.mode == CommunicationMode.INPROCESS:
            return False
        else:
            return await self._cancel_http(request, target)

    async def _cancel_websocket(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
    ) -> bool:
        """Cancel task via WebSocket.

        Args:
            request: Execution request
            target: Execution target configuration

        Returns:
            True if cancel request was sent successfully
        """
        from app.core.socketio import get_sio

        sio = get_sio()
        await sio.emit(
            "task:cancel",
            {"task_id": request.task_id, "subtask_id": request.subtask_id},
            room=target.room,
            namespace=target.namespace,
        )
        return True

    async def _cancel_http(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
    ) -> bool:
        """Cancel task via HTTP.

        Args:
            request: Execution request
            target: Execution target configuration

        Returns:
            True if cancel request was sent successfully
        """
        url = f"{target.url}/v1/cancel"
        payload: dict[str, Any] = {
            "task_id": request.task_id,
            "subtask_id": request.subtask_id,
        }
        if request.executor_name:
            payload["executor_name"] = request.executor_name

        logger.info(
            "[ExecutionDispatcher] Sending HTTP cancel: "
            "task_id=%s, subtask_id=%s, executor_name=%s, url=%s",
            request.task_id,
            request.subtask_id,
            request.executor_name,
            url,
        )
        try:
            response = await self.http_client.post(
                url,
                json=payload,
            )
            logger.info(
                "[ExecutionDispatcher] HTTP cancel response: "
                "task_id=%s, subtask_id=%s, executor_name=%s, status_code=%s",
                request.task_id,
                request.subtask_id,
                request.executor_name,
                response.status_code,
            )
            return response.status_code == 200
        except Exception as exc:
            logger.error(
                "[ExecutionDispatcher] HTTP cancel failed: "
                "task_id=%s, subtask_id=%s, executor_name=%s, error=%s",
                request.task_id,
                request.subtask_id,
                request.executor_name,
                exc,
                exc_info=True,
            )
            return False

    async def error(
        self,
        request: ExecutionRequest,
        error_message: str,
        device_id: Optional[str] = None,
        emitter: Optional[ResultEmitter] = None,
    ) -> None:
        """Send error event for a task.

        This is used for errors that occur before or outside of task execution,
        such as validation errors in retry/cancel handlers.

        Routes to the appropriate channel based on the request configuration,
        similar to dispatch and cancel methods.

        Args:
            request: Execution request (used for routing and task info)
            error_message: Error message to send
            device_id: Optional device ID for routing
            emitter: Optional emitter for frontend notification. If not provided,
                     only the execution service is notified (no frontend callback).
        """
        # Route to execution target
        target = self.router.route(request, device_id)

        logger.info(
            f"[ExecutionDispatcher] Sending error: task_id={request.task_id}, "
            f"subtask_id={request.subtask_id}, mode={target.mode.value}, "
            f"error={error_message}"
        )

        # Notify execution service based on communication mode
        if target.mode == CommunicationMode.SSE:
            await notify_chat_shell_error(
                request, target, error_message, self.http_client
            )
        elif target.mode == CommunicationMode.WEBSOCKET:
            await self._error_websocket(request, target, error_message)
        # HTTP mode doesn't need explicit error notification to executor

        # If emitter is provided, also emit error event to frontend
        if emitter is not None:
            # Wrap with StatusUpdatingEmitter for unified status updates
            wrapped_emitter = StatusUpdatingEmitter(
                wrapped=emitter,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
            )
            try:
                await wrapped_emitter.emit_error(
                    task_id=request.task_id,
                    subtask_id=request.subtask_id,
                    error=error_message,
                    message_id=request.message_id,
                )
            finally:
                await wrapped_emitter.close()

    async def _error_websocket(
        self,
        request: ExecutionRequest,
        target: ExecutionTarget,
        error_message: str,
    ) -> None:
        """Send error via WebSocket.

        For WebSocket mode, we send an error event to the device room.

        Args:
            request: Execution request
            target: Execution target configuration
            error_message: Error message
        """
        from app.core.socketio import get_sio

        sio = get_sio()
        await sio.emit(
            "task:error",
            {
                "task_id": request.task_id,
                "subtask_id": request.subtask_id,
                "error": error_message,
            },
            room=target.room,
            namespace=target.namespace,
        )


# Global instance
execution_dispatcher = ExecutionDispatcher()
