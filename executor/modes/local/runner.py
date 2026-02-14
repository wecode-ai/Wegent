# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Local mode runner for executor.

This module implements the main runner for local deployment mode,
which handles WebSocket connection, task queue management, and
agent execution.

Events are sent using OpenAI Responses API event types directly as Socket.IO
event names (e.g., "response.created", "response.completed", "error").
This allows backend's DeviceNamespace to route them correctly to
_handle_responses_api_event handler.
"""

import asyncio
import logging
import os
import signal
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

from executor.config import config
from executor.config.device_config import DeviceConfig
from executor.modes.local.events import ChatEvents, TaskEvents
from executor.modes.local.handlers import TaskHandler
from executor.modes.local.heartbeat import LocalHeartbeatService
from executor.modes.local.websocket_client import WebSocketClient
from shared.logger import setup_logger
from shared.models import ResponsesAPIEmitter
from shared.status import TaskStatus

logger = setup_logger("local_runner")


class LocalRunner:
    """Main runner for local executor mode.

    Features:
    - WebSocket connection to Backend for bidirectional communication
    - Device-based registration with unique device_id
    - Task queue for serial task execution (one task at a time)
    - Heartbeat service for connection health monitoring
    - Graceful shutdown handling via SIGINT/SIGTERM
    """

    def __init__(self, device_config: Optional[DeviceConfig] = None):
        """Initialize the local runner.

        Args:
            device_config: Optional device configuration. If not provided,
                          will use environment variables for backward compatibility.
        """
        self.device_config = device_config

        # WebSocket client
        self.websocket_client = WebSocketClient(device_config=device_config)

        # Heartbeat service
        self.heartbeat_service = LocalHeartbeatService(self.websocket_client)

        # Event handlers
        self.task_handler = TaskHandler(self)

        # Task queue for serial execution
        self.task_queue: asyncio.Queue = asyncio.Queue()

        # Current task tracking
        self.current_task: Optional[Dict[str, Any]] = None
        self.current_agent: Optional[Any] = None

        # Active sessions tracking (task_id -> session_info)
        # Each task_id represents an active Claude Code session/process
        self.active_sessions: Dict[int, Dict[str, Any]] = {}

        # Runner state
        self._running = False
        self._shutdown_event = asyncio.Event()

        # File logging handler (for cleanup on shutdown)
        self._file_handler: Optional[logging.Handler] = None

    def _handle_signal(self, signum: int, frame: Any) -> None:
        """Handle shutdown signals."""
        signal_name = signal.Signals(signum).name
        logger.info(f"Received {signal_name}, initiating graceful shutdown...")
        self._running = False
        if hasattr(self, "_shutdown_event"):
            try:
                loop = asyncio.get_running_loop()
                loop.call_soon_threadsafe(self._shutdown_event.set)
            except RuntimeError:
                self._shutdown_event.set()

    async def start(self) -> None:
        """Start the local executor runner.

        This is the main entry point that:
        1. Sets up file logging for local mode
        2. Sets up signal handlers
        3. Creates workspace directory
        4. Connects to Backend WebSocket
        5. Registers the device
        6. Starts heartbeat service
        7. Runs the task processing loop
        """
        self._setup_file_logging()

        logger.info("Starting Local Executor Runner...")
        logger.info(f"Backend URL: {config.WEGENT_BACKEND_URL}")
        logger.info(f"Auth Token: {'***' if config.WEGENT_AUTH_TOKEN else 'NOT SET'}")
        logger.info(f"Workspace Root: {config.LOCAL_WORKSPACE_ROOT}")
        self._running = True

        # Ensure workspace directory exists
        workspace_root = config.LOCAL_WORKSPACE_ROOT
        if not os.path.exists(workspace_root):
            os.makedirs(workspace_root, exist_ok=True)
            logger.info(f"Created workspace directory: {workspace_root}")

        # Setup signal handlers in the event loop
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, lambda s=sig: self._handle_signal(s, None))
            except NotImplementedError:
                signal.signal(sig, self._handle_signal)

        try:
            # Register WebSocket event handlers
            self._register_handlers()

            # Connect to Backend
            connected = await self.websocket_client.connect()
            if not connected:
                error_msg = self.websocket_client.connection_error or "Unknown error"
                logger.error(f"Failed to connect to Backend WebSocket: {error_msg}")
                logger.error(
                    "Please check:\n"
                    "  1. WEGENT_BACKEND_URL should be http://localhost:8000 (not wss://, not port 3000)\n"
                    "  2. Backend server is running on the specified URL\n"
                    "  3. WEGENT_AUTH_TOKEN is set"
                )
                return

            logger.info("WebSocket connected to Backend")

            # Register device with Backend (using call for acknowledgment)
            registered = await self.websocket_client.register_device()
            if not registered:
                logger.error("Failed to register device with Backend")
                return

            logger.info(
                f"Device registered: id={self.websocket_client.device_id}, "
                f"name={self.websocket_client.device_name}"
            )

            # Start heartbeat service
            await self.heartbeat_service.start()

            # Run task processing loop
            await self._task_loop()

        except Exception as e:
            logger.exception(f"Error in local runner: {e}")
        finally:
            await self._shutdown()

    async def _shutdown(self) -> None:
        """Perform graceful shutdown."""
        logger.info("Shutting down Local Executor Runner...")

        # Stop heartbeat service
        await self.heartbeat_service.stop()

        # Disconnect WebSocket
        await self.websocket_client.disconnect()

        logger.info("Local Executor Runner shutdown complete")

        # Flush file logging handler
        self._cleanup_file_logging()

    def _register_handlers(self) -> None:
        """Register WebSocket event handlers."""
        # Task events - use new event names
        self.websocket_client.on(
            TaskEvents.EXECUTE, self.task_handler.handle_task_dispatch
        )
        self.websocket_client.on(
            TaskEvents.CANCEL, self.task_handler.handle_task_cancel
        )
        self.websocket_client.on(
            TaskEvents.CLOSE_SESSION, self.task_handler.handle_task_close_session
        )
        self.websocket_client.on(
            ChatEvents.MESSAGE, self.task_handler.handle_chat_message
        )

        logger.info("WebSocket event handlers registered")

    async def enqueue_task(self, task_data: Dict[str, Any]) -> None:
        """Add a task to the execution queue."""
        task_id = task_data.get("task_id", -1)
        logger.info(f"Enqueuing task: task_id={task_id}")
        await self.task_queue.put(task_data)

    async def cancel_task(self, task_id: int) -> None:
        """Cancel a running task.

        Note: Cancel callback will be sent by response_processor after SDK interrupt
        messages are fully processed, to avoid duplicate status updates to frontend.
        """
        if self.current_task and self.current_task.get("task_id") == task_id:
            if self.current_agent and hasattr(self.current_agent, "cancel_run"):
                self.current_agent.cancel_run()
                logger.info(f"Cancelled task: task_id={task_id}")

                # NOTE: Do NOT send cancel callback here - response_processor will send it
                # after SDK interrupt messages are fully processed, avoiding duplicate callbacks
            else:
                logger.warning(
                    f"Cannot cancel task {task_id}: agent doesn't support cancellation"
                )
        else:
            logger.warning(f"Cannot cancel task {task_id}: not currently running")

    async def close_task_session(self, task_id: int) -> None:
        """Close a task session completely, freeing up the slot.

        This is different from cancel_task which only pauses execution.
        close_task_session terminates the entire session and cleanup.

        This method works even if the task is not currently running,
        as it directly cleans up the ClaudeCode client by task_id.

        Args:
            task_id: Task ID to close
        """
        logger.info(f"Closing session for task: task_id={task_id}")

        # If this is the current task, handle it
        if self.current_task and self.current_task.get("task_id") == task_id:
            # Cancel the task if agent supports it
            if self.current_agent and hasattr(self.current_agent, "cancel_run"):
                self.current_agent.cancel_run()

            # Cleanup agent resources
            if self.current_agent and hasattr(self.current_agent, "cleanup"):
                try:
                    self.current_agent.cleanup()
                    logger.info(
                        f"Cleaned up current agent resources for task {task_id}"
                    )
                except Exception as e:
                    logger.error(
                        f"Error cleaning up current agent for task {task_id}: {e}"
                    )

            # Clear current task
            self.current_task = None
            self.current_agent = None
        else:
            # Task is not currently running, but may have a lingering client
            logger.info(
                f"Task {task_id} is not currently running, attempting to cleanup client"
            )

        # Always try to cleanup ClaudeCode client for this task_id
        try:
            from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

            logger.info(
                f"[Runner] About to call cleanup_task_clients for task_id={task_id}"
            )
            # Cleanup any lingering client for this task_id
            cleaned = await ClaudeCodeAgent.cleanup_task_clients(task_id)
            logger.info(f"[Runner] cleanup_task_clients returned: cleaned={cleaned}")
            if cleaned > 0:
                logger.info(
                    f"Cleaned up {cleaned} ClaudeCode client(s) for task {task_id}"
                )
            else:
                logger.info(f"No ClaudeCode clients found for task {task_id}")
        except Exception as e:
            logger.error(
                f"Error cleaning up ClaudeCode clients for task {task_id}: {e}",
                exc_info=True,
            )

        logger.info(f"Task session closed: task_id={task_id}")

        # Send heartbeat immediately to update slot usage on backend
        try:
            await self.websocket_client.send_heartbeat()
            logger.info(f"Sent heartbeat after closing session for task {task_id}")
        except Exception as e:
            logger.error(f"Failed to send heartbeat after closing session: {e}")

    async def _task_loop(self) -> None:
        """Main task processing loop."""
        logger.info("Starting task processing loop")

        while self._running:
            try:
                try:
                    task_data = await asyncio.wait_for(
                        self.task_queue.get(), timeout=1.0
                    )
                except asyncio.TimeoutError:
                    continue

                try:
                    self.current_task = task_data
                    await self._execute_task(task_data)
                except Exception as e:
                    task_id = task_data.get("task_id", -1)
                    logger.exception(
                        f"Task execution failed for task_id={task_id}: {e}"
                    )
                    try:
                        await self._report_task_failure(task_data, str(e))
                    except Exception as report_err:
                        logger.exception(
                            f"Failed to report task failure for task_id={task_id}: {report_err}"
                        )
                finally:
                    self.current_task = None
                    self.current_agent = None
                    self.task_queue.task_done()

            except asyncio.CancelledError:
                logger.info("Task loop cancelled")
                break

        logger.info("Task processing loop ended")

    async def _on_client_created(self, task_id: int) -> None:
        """Callback for when Claude client is created (sends heartbeat update)."""
        try:
            await self.websocket_client.send_heartbeat()
            logger.info(
                f"[TaskStart] Sent heartbeat after Claude client created for task {task_id}"
            )
        except Exception as e:
            logger.warning(f"[TaskStart] Failed to send heartbeat: {e}")

    def _make_emitter_report_progress(self, emitter: ResponsesAPIEmitter) -> callable:
        """Create a progress callback that reports via emitter.

        Args:
            emitter: ResponsesAPIEmitter instance for sending events

        Returns:
            A callback function for reporting progress
        """

        def report(
            progress: int,
            status: Optional[str] = None,
            message: Optional[str] = None,
            result: Optional[Dict[str, Any]] = None,
        ) -> None:
            # Use emitter.in_progress() for progress updates
            asyncio.create_task(emitter.in_progress())

        return report

    def _create_emitter(self, task_id: int, subtask_id: int) -> ResponsesAPIEmitter:
        """Create a WebSocket emitter for local mode.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID

        Returns:
            ResponsesAPIEmitter configured with WebSocket transport
        """
        from shared.models import EmitterBuilder, WebSocketTransport

        # Create WebSocket transport for local mode
        # No event_mapping - use original OpenAI Responses API event types as Socket.IO event names
        # This allows backend's DeviceNamespace to route events correctly to _handle_responses_api_event
        ws_transport = WebSocketTransport(self.websocket_client)

        # Create WebSocket emitter for local mode
        return (
            EmitterBuilder()
            .with_task(task_id, subtask_id)
            .with_transport(ws_transport)
            .build()
        )

    async def _execute_task(self, task_data: Dict[str, Any]) -> None:
        """Execute a single task."""
        task_id = task_data.get("task_id", -1)
        subtask_id = task_data.get("subtask_id", -1)
        logger.info(f"Executing task: task_id={task_id}, subtask_id={subtask_id}")

        from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

        # Create WebSocket emitter for local mode
        ws_emitter = self._create_emitter(task_id, subtask_id)

        # Create and initialize agent with WebSocket emitter
        self.current_agent = ClaudeCodeAgent(task_data, emitter=ws_emitter)

        self.current_agent.on_client_created_callback = lambda: self._on_client_created(
            task_id
        )
        self.current_agent.report_progress = self._make_emitter_report_progress(
            ws_emitter
        )

        # Report task started via emitter (response.in_progress)
        await ws_emitter.in_progress()

        # Initialize agent
        init_status = self.current_agent.initialize()
        if init_status != TaskStatus.SUCCESS:
            logger.error(f"Agent initialization failed: {init_status}")
            await ws_emitter.error("Agent initialization failed", "init_error")
            return

        # Pre-execute
        pre_status = self.current_agent.pre_execute()
        if pre_status != TaskStatus.SUCCESS:
            logger.error(f"Agent pre-execution failed: {pre_status}")
            await ws_emitter.error("Agent pre-execution failed", "pre_execute_error")
            return

        # Execute the task (Claude client will be created inside, triggering heartbeat callback)
        result = await self.current_agent.execute_async()
        logger.info(f"Task execution completed: task_id={task_id}")

        # Get execution result for logging
        execution_result = {}
        if (
            hasattr(self.current_agent, "state_manager")
            and self.current_agent.state_manager
        ):
            execution_result = (
                self.current_agent.state_manager.get_current_state() or {}
            )
            # Truncate execution_result to 20 characters for logging
            result_str = str(execution_result)
            truncated_result = (
                result_str[:20] + "..." if len(result_str) > 20 else result_str
            )
            logger.info(f"Execution result for task_id={task_id}: {truncated_result}")

            # Log workbench status if present
            if "workbench" in execution_result:
                workbench_status = execution_result["workbench"].get("status", "N/A")
                logger.info(
                    f"Workbench status for task_id={task_id}: {workbench_status}"
                )

        # Only report final result for non-success cases.
        # For success, response_processor.py already sends the response.completed
        # event with correct content via emitter -> WebSocket transport.
        # Sending another response.completed here would overwrite the DB with
        # empty content (since get_current_state() doesn't include "value").
        if result == TaskStatus.CANCELLED:
            await ws_emitter.incomplete(reason="cancelled")
        elif result != TaskStatus.COMPLETED:
            error_msg = execution_result.get(
                "error", f"Task failed with status: {result.value}"
            )
            await ws_emitter.error(error_msg, "execution_error")

    async def _report_task_failure(
        self, task_data: Dict[str, Any], error_message: str
    ) -> None:
        """Report task failure via WebSocket emitter."""
        task_id = task_data.get("task_id", -1)
        subtask_id = task_data.get("subtask_id", -1)

        # Create emitter for error reporting
        ws_emitter = self._create_emitter(task_id, subtask_id)
        await ws_emitter.error(error_message, "execution_error")

    def _setup_file_logging(self) -> None:
        """Configure file logging for local mode."""
        try:
            log_dir = config.WEGENT_EXECUTOR_LOG_DIR
            Path(log_dir).mkdir(parents=True, exist_ok=True)

            log_file = os.path.join(log_dir, config.WEGENT_EXECUTOR_LOG_FILE)
            max_bytes = config.WEGENT_EXECUTOR_LOG_MAX_SIZE * 1024 * 1024
            backup_count = config.WEGENT_EXECUTOR_LOG_BACKUP_COUNT

            file_handler = RotatingFileHandler(
                log_file,
                maxBytes=max_bytes,
                backupCount=backup_count,
                encoding="utf-8",
            )

            formatter = logging.Formatter(
                "%(asctime)s - [%(request_id)s] - [%(name)s] - %(levelname)s - %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
            file_handler.setFormatter(formatter)

            log_level = logging.INFO
            env_log_level = os.environ.get("LOG_LEVEL")
            if env_log_level and env_log_level.upper() == "DEBUG":
                log_level = logging.DEBUG
            file_handler.setLevel(log_level)

            from shared.logger import RequestIdFilter

            file_handler.addFilter(RequestIdFilter())

            logger_names = [
                "local_runner",
                "websocket_client",
                "local_heartbeat",
                "local_handlers",
                "task_executor",
                "executor.config.config_loader",
                # Agent and download loggers
                "claude_code_agent",
                "executor.services.attachment_downloader",
                "progress_state_manager",  # Add for unified state management logging
                "claude_response_processor",  # Add for cancellation flow logging
            ]
            for name in logger_names:
                log = logging.getLogger(name)
                log.addHandler(file_handler)

            self._file_handler = file_handler

            logger.info(f"File logging enabled: {log_file}")
            logger.info(
                f"Log rotation: max {config.WEGENT_EXECUTOR_LOG_MAX_SIZE}MB, "
                f"keep {backup_count} backups"
            )

        except Exception as e:
            logger.warning(f"Failed to setup file logging: {e}")

    def _cleanup_file_logging(self) -> None:
        """Flush and close file logging handler on shutdown."""
        if self._file_handler:
            try:
                self._file_handler.flush()
                self._file_handler.close()
                # Remove handler from all loggers to prevent errors during shutdown
                logger_names = [
                    "local_runner",
                    "websocket_client",
                    "local_heartbeat",
                    "local_handlers",
                    "task_executor",
                    "executor.config.config_loader",
                    "claude_code_agent",
                    "executor.services.attachment_downloader",
                ]
                for name in logger_names:
                    log = logging.getLogger(name)
                    log.removeHandler(self._file_handler)
            except Exception:
                pass
