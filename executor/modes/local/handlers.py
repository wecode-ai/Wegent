# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Event handlers for local executor mode.

This module implements handlers for events received from the Backend server.
"""

import asyncio
import threading
from typing import TYPE_CHECKING, Any, Dict, Optional

from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest

if TYPE_CHECKING:
    from executor.modes.local.runner import LocalRunner

logger = setup_logger("local_handlers")


class TaskHandler:
    """Handler for task-related events from Backend."""

    def __init__(self, runner: "LocalRunner"):
        """Initialize the task handler.

        Args:
            runner: The LocalRunner instance for task execution.
        """
        self.runner = runner

    async def handle_task_dispatch(self, data: Dict[str, Any]) -> None:
        """Handle task dispatch event from Backend.

        This is called when Backend pushes a new task to execute.

        Args:
            data: Task data dictionary containing:
                - task_id: Task ID
                - subtask_id: Subtask ID
                - prompt: Task prompt
                - bot: Bot configuration (includes agent_config.env for Claude API)
                - auth_token: JWT token for HTTP API calls (Skills, attachments)
                - attachments: List of attachments
                - git_url, branch_name, etc.
        """
        task_id = data.get("task_id", -1)
        subtask_id = data.get("subtask_id", -1)
        logger.info(
            f"Received task dispatch: task_id={task_id}, subtask_id={subtask_id}"
        )

        # Convert dict to ExecutionRequest and enqueue
        execution_request = ExecutionRequest.from_dict(data)
        await self.runner.enqueue_task(execution_request)

    async def handle_task_cancel(self, data: Dict[str, Any]) -> None:
        """Handle task cancel event from Backend.

        Args:
            data: Cancel data containing task_id.
        """
        task_id = data.get("task_id")
        if task_id is not None:
            logger.info(f"Received task cancel request: task_id={task_id}")
            await self.runner.cancel_task(task_id)
        else:
            logger.warning("Received cancel request without task_id")

    async def handle_task_close_session(self, data: Dict[str, Any]) -> None:
        """Handle task close session event from Backend.

        This completely terminates the task session and frees up the slot,
        unlike cancel which only pauses execution.

        Args:
            data: Close session data containing task_id.
        """
        task_id = data.get("task_id")
        if task_id is not None:
            logger.info(f"Received task close session request: task_id={task_id}")
            await self.runner.close_task_session(task_id)
        else:
            logger.warning("Received close session request without task_id")

    async def handle_chat_message(self, data: Dict[str, Any]) -> None:
        """Handle chat message event from Backend.

        This is used for follow-up messages in an existing chat session.

        Args:
            data: Chat message data (same structure as task dispatch).
        """
        task_id = data.get("task_id", -1)
        subtask_id = data.get("subtask_id", -1)
        logger.info(
            f"Received chat message: task_id={task_id}, subtask_id={subtask_id}"
        )

        # Chat messages are processed as tasks
        execution_request = ExecutionRequest.from_dict(data)
        await self.runner.enqueue_task(execution_request)


class ConnectionHandler:
    """Handler for connection-related events."""

    def __init__(self, runner: "LocalRunner"):
        """Initialize the connection handler.

        Args:
            runner: The LocalRunner instance.
        """
        self.runner = runner

    async def handle_connect(self) -> None:
        """Handle successful connection."""
        logger.info("Connected to Backend WebSocket")
        # Note: Registration is handled by LocalRunner.start() after connection
        # and by reconnection logic in the internal handlers.

    async def handle_disconnect(self) -> None:
        """Handle disconnection."""
        logger.warning("Disconnected from Backend WebSocket")
        # The WebSocket client will handle automatic reconnection

    async def handle_connect_error(self, data: Any) -> None:
        """Handle connection error.

        Args:
            data: Error information.
        """
        logger.error(f"WebSocket connection error: {data}")


class UpgradeHandler:
    """Handler for upgrade-related events from Backend."""

    def __init__(self, runner: "LocalRunner"):
        """Initialize the upgrade handler.

        Args:
            runner: The LocalRunner instance.
        """
        self.runner = runner
        self._upgrade_in_progress = False
        self._upgrade_lock = threading.Lock()

    async def handle_upgrade_command(self, data: Dict[str, Any]) -> None:
        """Handle device:upgrade event from Backend.

        This method receives upgrade commands from the backend and orchestrates
        the upgrade process, emitting status updates back to the backend.

        Args:
            data: Upgrade command data containing:
                - force: Force upgrade even if on latest version
                - auto_confirm: Skip user confirmation
                - verbose: Enable verbose logging
                - force_stop_tasks: Cancel running tasks before upgrade
                - registry: Optional registry URL override
                - registry_token: Optional registry auth token
        """
        device_id = self.runner.websocket_client.device_id

        # Check if upgrade already in progress
        with self._upgrade_lock:
            if self._upgrade_in_progress:
                await self._emit_status(
                    "error", "Upgrade already in progress", device_id=device_id
                )
                return
            self._upgrade_in_progress = True

        try:
            # Check for running tasks
            if self.runner.has_running_tasks():
                force_stop = data.get("force_stop_tasks", False)
                if not force_stop:
                    await self._emit_status(
                        "busy",
                        "Cannot upgrade: tasks are running",
                        device_id=device_id,
                    )
                    with self._upgrade_lock:
                        self._upgrade_in_progress = False
                    return
                else:
                    # Cancel all running tasks
                    logger.info("[UpgradeHandler] Cancelling all running tasks")
                    await self.runner.cancel_all_tasks()

            # Emit initial status
            await self._emit_status(
                "checking", "Checking for updates...", device_id=device_id
            )

            # Run upgrade in background thread to not block WebSocket
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                self._execute_upgrade_sync,
                data.get("force", False),
                data.get("auto_confirm", True),
                data.get("verbose", False),
                data.get("registry"),
                data.get("registry_token"),
            )

            # Emit final status based on result
            if result.success:
                if result.already_latest:
                    await self._emit_status(
                        "skipped",
                        "Already on latest version",
                        device_id=device_id,
                        old_version=result.old_version,
                    )
                else:
                    await self._emit_status(
                        "success",
                        "Upgrade completed successfully",
                        device_id=device_id,
                        old_version=result.old_version,
                        new_version=result.new_version,
                    )
                    # Emit restarting status before actual restart
                    await self._emit_status(
                        "restarting",
                        "Restarting executor...",
                        device_id=device_id,
                        new_version=result.new_version,
                    )
                    # Trigger auto-restart
                    await self._trigger_restart()
            else:
                await self._emit_status(
                    "error",
                    f"Upgrade failed: {result.error}",
                    device_id=device_id,
                    error=result.error,
                )

        except Exception as e:
            logger.exception(f"[UpgradeHandler] Error during upgrade: {e}")
            await self._emit_status(
                "error",
                f"Unexpected error: {str(e)}",
                device_id=device_id,
                error=str(e),
            )
        finally:
            with self._upgrade_lock:
                self._upgrade_in_progress = False

    def _execute_upgrade_sync(
        self,
        force: bool,
        auto_confirm: bool,
        verbose: bool,
        registry: Optional[str],
        registry_token: Optional[str],
    ) -> "UpdateResult":
        """Execute upgrade synchronously (runs in background thread).

        Args:
            force: Force upgrade even if on latest version
            auto_confirm: Skip user confirmation
            verbose: Enable verbose logging
            registry: Optional registry URL override
            registry_token: Optional registry auth token

        Returns:
            UpdateResult with the outcome of the update
        """
        import asyncio

        from executor.config.device_config import UpdateConfig
        from executor.services.updater.updater_service import UpdaterService

        # Get update config from device-config, or create empty one if not available
        if self.runner.device_config and self.runner.device_config.update:
            update_config = UpdateConfig(
                registry=self.runner.device_config.update.registry,
                registry_token=self.runner.device_config.update.registry_token,
            )
        else:
            update_config = UpdateConfig()

        # Override with values from backend request if provided
        if registry:
            update_config.registry = registry
        if registry_token:
            update_config.registry_token = registry_token

        # Create updater service
        service = UpdaterService(
            update_config=update_config,
            auto_confirm=auto_confirm,
            verbose=verbose,
        )

        # Run the update check and download
        return asyncio.run(service.check_and_update())

    async def _emit_status(
        self,
        status: str,
        message: str,
        device_id: Optional[str] = None,
        old_version: Optional[str] = None,
        new_version: Optional[str] = None,
        progress: Optional[int] = None,
        error: Optional[str] = None,
    ) -> None:
        """Emit upgrade status update to Backend.

        Args:
            status: Status string (checking, downloading, installing, etc.)
            message: Human-readable message
            device_id: Device ID (defaults to runner's device ID)
            old_version: Version before upgrade
            new_version: Version after upgrade
            progress: Download progress (0-100)
            error: Error details if status is error
        """
        if device_id is None:
            device_id = self.runner.websocket_client.device_id

        status_data = {
            "device_id": device_id,
            "status": status,
            "message": message,
        }

        if old_version is not None:
            status_data["old_version"] = old_version
        if new_version is not None:
            status_data["new_version"] = new_version
        if progress is not None:
            status_data["progress"] = progress
        if error is not None:
            status_data["error"] = error

        try:
            await self.runner.websocket_client.emit(
                "device:upgrade_status", status_data
            )
            logger.debug(f"[UpgradeHandler] Emitted status: {status}")
        except Exception as e:
            logger.error(f"[UpgradeHandler] Failed to emit status: {e}")

    async def _trigger_restart(self) -> None:
        """Trigger executor restart after successful upgrade.

        This schedules a restart to happen after the status is sent.
        """
        logger.info("[UpgradeHandler] Scheduling executor restart in 2 seconds...")

        async def delayed_restart():
            await asyncio.sleep(2)
            logger.info("[UpgradeHandler] Executing restart now")
            # Use the process manager to restart
            from executor.services.updater.process_manager import ProcessManager

            pm = ProcessManager()
            success = pm.restart_executor()
            if success:
                logger.info("[UpgradeHandler] New executor started, exiting current process")
                import sys
                sys.exit(0)

        # Schedule the restart without awaiting it
        asyncio.create_task(delayed_restart())
