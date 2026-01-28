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
import os
import platform
import signal
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from executor.config import config
from executor.modes.local.events import (
    LocalChatEvents,
    LocalExecutorEvents,
    LocalTaskEvents,
)
from executor.modes.local.handlers import ConnectionHandler, TaskHandler
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
    - Task queue for serial task execution (one task at a time)
    - Heartbeat service for connection health monitoring
    - Graceful shutdown handling via SIGINT/SIGTERM
    """

    VERSION = "1.0.0"

    def __init__(self):
        """Initialize the local runner."""
        # WebSocket client
        self.websocket_client = WebSocketClient()

        # Heartbeat service
        self.heartbeat_service = LocalHeartbeatService(self.websocket_client)

        # Event handlers
        self.task_handler = TaskHandler(self)
        self.connection_handler = ConnectionHandler(self)

        # Task queue for serial execution
        self.task_queue: asyncio.Queue = asyncio.Queue()

        # Current task tracking
        self.current_task: Optional[Dict[str, Any]] = None
        self.current_agent: Optional[Any] = None

        # Runner state
        self._running = False
        self._shutdown_event = asyncio.Event()

        # Setup signal handlers
        self._setup_signal_handlers()

    def _setup_signal_handlers(self) -> None:
        """Setup signal handlers for graceful shutdown."""
        # Note: Signal handlers in asyncio should be set in the main thread
        # We'll handle this in start() method
        pass

    def _handle_signal(self, signum: int, frame: Any) -> None:
        """Handle shutdown signals.

        Args:
            signum: Signal number.
            frame: Current stack frame.
        """
        signal_name = signal.Signals(signum).name
        logger.info(f"Received {signal_name}, initiating graceful shutdown...")
        self._running = False
        # Set shutdown event to wake up any waiting coroutines
        if hasattr(self, "_shutdown_event"):
            # Schedule the set in the event loop
            try:
                loop = asyncio.get_running_loop()
                loop.call_soon_threadsafe(self._shutdown_event.set)
            except RuntimeError:
                # No running loop, just set it
                self._shutdown_event.set()

    async def start(self) -> None:
        """Start the local executor runner.

        This is the main entry point that:
        1. Sets up signal handlers
        2. Connects to Backend WebSocket
        3. Registers the executor
        4. Starts heartbeat service
        5. Runs the task processing loop
        """
        logger.info("Starting Local Executor Runner...")
        logger.info(f"Backend URL: {config.WEGENT_BACKEND_URL}")
        logger.info(f"Auth Token: {'***' if config.WEGENT_AUTH_TOKEN else 'NOT SET'}")
        self._running = True

        # Setup signal handlers in the event loop
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, lambda s=sig: self._handle_signal(s, None))
            except NotImplementedError:
                # Windows doesn't support add_signal_handler
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

            # Register executor with Backend
            await self._register()

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

        # Unregister from Backend
        try:
            await self._unregister()
        except Exception as e:
            logger.warning(f"Error during unregister: {e}")

        # Disconnect WebSocket
        await self.websocket_client.disconnect()

        logger.info("Local Executor Runner shutdown complete")

    def _register_handlers(self) -> None:
        """Register WebSocket event handlers."""
        # Task events
        self.websocket_client.on(
            LocalTaskEvents.DISPATCH, self.task_handler.handle_task_dispatch
        )
        self.websocket_client.on(
            LocalTaskEvents.CANCEL, self.task_handler.handle_task_cancel
        )
        self.websocket_client.on(
            LocalChatEvents.MESSAGE, self.task_handler.handle_chat_message
        )

        # Connection events (handled by socketio internally, we log here)
        @self.websocket_client.sio.event
        async def connect():
            await self.connection_handler.handle_connect()

        @self.websocket_client.sio.event
        async def disconnect():
            await self.connection_handler.handle_disconnect()

        @self.websocket_client.sio.event
        async def connect_error(data):
            await self.connection_handler.handle_connect_error(data)

        logger.debug("WebSocket event handlers registered")

    async def _register(self) -> None:
        """Register this executor with Backend."""
        registration_data = {
            "executor_type": "local",
            "platform": sys.platform,
            "arch": platform.machine(),
            "version": self.VERSION,
            "capabilities": ["claude_code"],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "hostname": platform.node(),
        }

        await self.websocket_client.emit(
            LocalExecutorEvents.REGISTER, registration_data
        )
        logger.info(f"Registered local executor: {registration_data}")

    async def _unregister(self) -> None:
        """Unregister this executor from Backend."""
        if self.websocket_client.connected:
            await self.websocket_client.emit(
                LocalExecutorEvents.UNREGISTER,
                {"timestamp": datetime.now(timezone.utc).isoformat()},
            )
            logger.info("Unregistered local executor")

    async def enqueue_task(self, task_data: Dict[str, Any]) -> None:
        """Add a task to the execution queue.

        Args:
            task_data: Task data from Backend.
        """
        task_id = task_data.get("task_id", -1)
        logger.info(f"Enqueuing task: task_id={task_id}")
        await self.task_queue.put(task_data)

    async def cancel_task(self, task_id: int) -> None:
        """Cancel a running task.

        Args:
            task_id: Task ID to cancel.
        """
        if self.current_task and self.current_task.get("task_id") == task_id:
            if self.current_agent and hasattr(self.current_agent, "cancel_run"):
                self.current_agent.cancel_run()
                logger.info(f"Cancelled task: task_id={task_id}")
            else:
                logger.warning(
                    f"Cannot cancel task {task_id}: agent doesn't support cancellation"
                )
        else:
            logger.warning(f"Cannot cancel task {task_id}: not currently running")

    async def _task_loop(self) -> None:
        """Main task processing loop.

        Processes tasks from the queue one at a time (serial execution).
        """
        logger.info("Starting task processing loop")

        while self._running:
            try:
                # Wait for task with timeout to allow shutdown check
                try:
                    task_data = await asyncio.wait_for(
                        self.task_queue.get(), timeout=1.0
                    )
                except asyncio.TimeoutError:
                    continue

                # Process the task
                try:
                    self.current_task = task_data
                    await self._execute_task(task_data)
                except Exception as e:
                    task_id = task_data.get("task_id", -1)
                    logger.exception(
                        f"Task execution failed for task_id={task_id}: {e}"
                    )

                    # Report failure via WebSocket
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
        """Execute a single task.

        Args:
            task_data: Task data containing all necessary information.
        """
        task_id = task_data.get("task_id", -1)
        subtask_id = task_data.get("subtask_id", -1)
        logger.info(f"Executing task: task_id={task_id}, subtask_id={subtask_id}")

        # Import here to avoid circular imports
        from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent

        # Create progress reporter
        progress_reporter = WebSocketProgressReporter(
            websocket_client=self.websocket_client,
            task_id=task_id,
            subtask_id=subtask_id,
            task_title=task_data.get("task_title", ""),
            subtask_title=task_data.get("subtask_title", ""),
        )

        # Store progress reporter in task_data for agent use
        task_data["_local_progress_reporter"] = progress_reporter

        # Create and initialize agent
        self.current_agent = ClaudeCodeAgent(task_data)

        # Override report_progress to use WebSocket
        original_report_progress = self.current_agent.report_progress

        def websocket_report_progress(
            progress: int,
            status: Optional[str] = None,
            message: Optional[str] = None,
            result: Optional[Dict[str, Any]] = None,
        ) -> None:
            """Report progress via WebSocket instead of HTTP callback."""
            # Create coroutine and schedule it
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

        # Initialize agent (downloads skills, etc.)
        init_status = self.current_agent.initialize()
        if init_status != TaskStatus.SUCCESS:
            logger.error(f"Agent initialization failed: {init_status}")
            await progress_reporter.report_result(
                status=TaskStatus.FAILED.value,
                result={"error": "Agent initialization failed"},
                message="Agent initialization failed",
            )
            return

        # Pre-execute (download code, attachments, etc.)
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

        # Get execution result from agent
        execution_result = {}
        if hasattr(self.current_agent, "get_execution_result"):
            execution_result = self.current_agent.get_execution_result() or {}

        # Report final result
        await progress_reporter.report_result(
            status=result.value,
            result=execution_result,
            message=f"Task completed with status: {result.value}",
        )

    async def _report_task_failure(
        self, task_data: Dict[str, Any], error_message: str
    ) -> None:
        """Report task failure via WebSocket.

        Args:
            task_data: Task data.
            error_message: Error message.
        """
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
