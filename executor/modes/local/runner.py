# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Local mode runner for executor.

This module implements the main runner for local deployment mode,
which handles WebSocket connection, task queue management, and
agent execution.
"""

import asyncio
import logging
import os
import signal
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

from executor.config import config
from executor.modes.local.events import ChatEvents, TaskEvents
from executor.modes.local.handlers import TaskHandler
from executor.modes.local.heartbeat import LocalHeartbeatService
from executor.modes.local.progress_reporter import WebSocketProgressReporter
from executor.modes.local.websocket_client import WebSocketClient
from shared.logger import setup_logger
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

    def __init__(self):
        """Initialize the local runner."""
        # WebSocket client
        self.websocket_client = WebSocketClient()

        # Heartbeat service
        self.heartbeat_service = LocalHeartbeatService(self.websocket_client)

        # Event handlers
        self.task_handler = TaskHandler(self)

        # Task queue for serial execution
        self.task_queue: asyncio.Queue = asyncio.Queue()

        # Current task tracking
        self.current_task: Optional[Dict[str, Any]] = None
        self.current_agent: Optional[Any] = None

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
            ChatEvents.MESSAGE, self.task_handler.handle_chat_message
        )

        logger.info("WebSocket event handlers registered")

    async def enqueue_task(self, task_data: Dict[str, Any]) -> None:
        """Add a task to the execution queue."""
        task_id = task_data.get("task_id", -1)
        logger.info(f"Enqueuing task: task_id={task_id}")
        await self.task_queue.put(task_data)

    async def cancel_task(self, task_id: int) -> None:
        """Cancel a running task and send CANCELLED callback."""
        if self.current_task and self.current_task.get("task_id") == task_id:
            if self.current_agent and hasattr(self.current_agent, "cancel_run"):
                self.current_agent.cancel_run()
                logger.info(f"Cancelled task: task_id={task_id}")

                # Send CANCELLED status callback
                await self._send_cancel_callback(task_id)
            else:
                logger.warning(
                    f"Cannot cancel task {task_id}: agent doesn't support cancellation"
                )
        else:
            logger.warning(f"Cannot cancel task {task_id}: not currently running")

    async def _send_cancel_callback(self, task_id: int) -> None:
        """Send CANCELLED status callback to Backend."""
        try:
            if not self.current_task:
                return

            subtask_id = self.current_task.get("subtask_id", -1)
            task_title = self.current_task.get("task_title", "")
            subtask_title = self.current_task.get("subtask_title", "")

            await self.websocket_client.emit(
                TaskEvents.PROGRESS,
                {
                    "task_id": task_id,
                    "subtask_id": subtask_id,
                    "task_title": task_title,
                    "subtask_title": subtask_title,
                    "progress": 100,
                    "status": "cancelled",
                    "message": "${{tasks.cancel_task}}",
                },
            )
            logger.info(f"Cancel callback sent for task {task_id}")
        except Exception as e:
            logger.error(f"Failed to send cancel callback for task {task_id}: {e}")

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
                    await self._report_task_failure(task_data, str(e))
                finally:
                    self.current_task = None
                    self.current_agent = None
                    self.task_queue.task_done()

            except asyncio.CancelledError:
                logger.info("Task loop cancelled")
                break

        logger.info("Task processing loop ended")

    async def _execute_task(self, task_data: Dict[str, Any]) -> None:
        """Execute a single task."""
        task_id = task_data.get("task_id", -1)
        subtask_id = task_data.get("subtask_id", -1)
        logger.info(f"Executing task: task_id={task_id}, subtask_id={subtask_id}")

        from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

        # Create progress reporter
        progress_reporter = WebSocketProgressReporter(
            websocket_client=self.websocket_client,
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_data.get("task_title", ""),
            subtask_title=task_data.get("subtask_title", ""),
        )

        task_data["_local_progress_reporter"] = progress_reporter

        # Create and initialize agent
        self.current_agent = ClaudeCodeAgent(task_data)

        def websocket_report_progress(
            progress: int,
            status: Optional[str] = None,
            message: Optional[str] = None,
            result: Optional[Dict[str, Any]] = None,
        ) -> None:
            asyncio.create_task(
                progress_reporter.report_progress(
                    progress=progress,
                    status=status or "",
                    message=message or "",
                    result=result,
                )
            )

        self.current_agent.report_progress = websocket_report_progress

        # Report task started
        await progress_reporter.report_progress(
            progress=10,
            status=TaskStatus.RUNNING.value,
            message="${{thinking.task_started}}",
        )

        # Initialize agent
        init_status = self.current_agent.initialize()
        if init_status != TaskStatus.SUCCESS:
            logger.error(f"Agent initialization failed: {init_status}")
            await progress_reporter.report_result(
                status=TaskStatus.FAILED.value,
                result={"error": "Agent initialization failed"},
                message="Agent initialization failed",
            )
            return

        # Pre-execute
        pre_status = self.current_agent.pre_execute()
        if pre_status != TaskStatus.SUCCESS:
            logger.error(f"Agent pre-execution failed: {pre_status}")
            await progress_reporter.report_result(
                status=TaskStatus.FAILED.value,
                result={"error": "Agent pre-execution failed"},
                message="Agent pre-execution failed",
            )
            return

        # Execute the task
        result = await self.current_agent.execute_async()
        logger.info(f"Task execution completed: task_id={task_id}, result={result}")

        # Get execution result
        execution_result = {}
        if (
            hasattr(self.current_agent, "state_manager")
            and self.current_agent.state_manager
        ):
            execution_result = (
                self.current_agent.state_manager.get_current_state() or {}
            )
            logger.info(f"Execution result for task_id={task_id}: {execution_result}")

        # Report final result
        await progress_reporter.report_result(
            status=result.value,
            result=execution_result,
            message=f"Task completed with status: {result.value}",
        )

    async def _report_task_failure(
        self, task_data: Dict[str, Any], error_message: str
    ) -> None:
        """Report task failure via WebSocket."""
        task_id = task_data.get("task_id", -1)
        subtask_id = task_data.get("subtask_id", -1)

        progress_reporter = WebSocketProgressReporter(
            websocket_client=self.websocket_client,
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_data.get("task_title", ""),
            subtask_title=task_data.get("subtask_title", ""),
        )

        await progress_reporter.report_result(
            status=TaskStatus.FAILED.value,
            result={"error": error_message},
            message=error_message,
        )

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
                "websocket_progress_reporter",
                "task_executor",
                "executor.config.config_loader",
                # Agent and download loggers
                "claude_code_agent",
                "executor.services.attachment_downloader",
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
                    "websocket_progress_reporter",
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
