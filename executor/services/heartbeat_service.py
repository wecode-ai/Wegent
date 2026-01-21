# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Heartbeat service for executor health monitoring.

This module provides a background service that:
- Sends periodic heartbeat signals to executor_manager
- Enables detection of executor container failures
- Supports configurable heartbeat interval
- Supports both sandbox (long-lived) and task (regular) heartbeat types
"""

import os
import threading
import time
from typing import Optional

import requests

from shared.logger import setup_logger

logger = setup_logger("heartbeat_service")

# Default configuration
DEFAULT_HEARTBEAT_INTERVAL = 10  # seconds
DEFAULT_HEARTBEAT_TIMEOUT = 5  # HTTP request timeout


class HeartbeatService:
    """Background service that sends periodic heartbeats to executor_manager.

    The service runs in a daemon thread and sends HTTP POST requests to
    the executor_manager's heartbeat endpoint at regular intervals.

    When the executor container dies unexpectedly, the heartbeat stops
    and executor_manager can detect this via heartbeat timeout.

    Supports two heartbeat types:
    - sandbox: For long-lived sandbox tasks (uses sandbox_id)
    - task: For regular online/offline tasks (uses task_id)
    """

    _instance: Optional["HeartbeatService"] = None
    _lock = threading.Lock()

    def __init__(
        self,
        heartbeat_id: Optional[str] = None,
        heartbeat_type: Optional[str] = None,
        heartbeat_url: Optional[str] = None,
        interval: Optional[int] = None,
    ):
        """Initialize the heartbeat service.

        Args:
            heartbeat_id: Heartbeat ID (sandbox_id or task_id). If not provided,
                         reads from HEARTBEAT_ID or SANDBOX_ID environment variable.
            heartbeat_type: Type of heartbeat ('sandbox' or 'task'). If not provided,
                           reads from HEARTBEAT_TYPE environment variable.
            heartbeat_url: Full URL for heartbeat endpoint. If not provided,
                          constructs from EXECUTOR_MANAGER_HEARTBEAT_BASE_URL or CALLBACK_URL.
            interval: Heartbeat interval in seconds. If not provided,
                     reads from HEARTBEAT_INTERVAL env var or uses default.
        """
        # Get heartbeat ID from new env var first, fall back to legacy SANDBOX_ID
        self._heartbeat_id = (
            heartbeat_id or os.getenv("HEARTBEAT_ID") or os.getenv("SANDBOX_ID")
        )

        # Get heartbeat type: 'sandbox' or 'task'
        self._heartbeat_type = heartbeat_type or os.getenv("HEARTBEAT_TYPE", "sandbox")

        self._interval = interval or int(
            os.getenv("HEARTBEAT_INTERVAL", str(DEFAULT_HEARTBEAT_INTERVAL))
        )
        self._enabled = os.getenv("HEARTBEAT_ENABLED", "false").lower() == "true"
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._claude_initialized = False  # Track if Claude has been initialized

        # Build heartbeat URL based on type
        if heartbeat_url:
            self._heartbeat_url = heartbeat_url
        else:
            self._heartbeat_url = self._build_heartbeat_url()

    def _build_heartbeat_url(self) -> str:
        """Build the heartbeat URL based on heartbeat type.

        Returns:
            The heartbeat URL string
        """
        heartbeat_base = os.getenv("EXECUTOR_MANAGER_HEARTBEAT_BASE_URL")

        if not heartbeat_base:
            # Derive from CALLBACK_URL for backward compatibility
            callback_url = os.getenv(
                "CALLBACK_URL",
                "http://localhost:8001/executor-manager/callback",
            )
            # From: http://host:port/executor-manager/callback
            # To:   http://host:port/executor-manager
            heartbeat_base = callback_url.replace("/callback", "")

        heartbeat_base = heartbeat_base.rstrip("/")

        # Build URL based on heartbeat type
        if self._heartbeat_type == "sandbox":
            return f"{heartbeat_base}/sandboxes/{self._heartbeat_id}/heartbeat"
        else:
            # For regular tasks, use a different endpoint
            return f"{heartbeat_base}/tasks/{self._heartbeat_id}/heartbeat"

    @classmethod
    def get_instance(cls) -> "HeartbeatService":
        """Get the singleton instance of HeartbeatService.

        Returns:
            The HeartbeatService singleton
        """
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @property
    def is_enabled(self) -> bool:
        """Check if heartbeat service is enabled."""
        return self._enabled and self._heartbeat_id is not None

    @property
    def is_running(self) -> bool:
        """Check if heartbeat service is currently running."""
        return self._running

    def start(self) -> bool:
        """Start the heartbeat service in a background thread.

        Returns:
            True if started successfully, False if disabled or already running
        """
        if not self.is_enabled:
            logger.info(
                f"[HeartbeatService] Disabled or no heartbeat_id configured "
                f"(enabled={self._enabled}, heartbeat_id={self._heartbeat_id})"
            )
            return False

        if self._running:
            logger.warning("[HeartbeatService] Already running")
            return False

        self._running = True
        self._thread = threading.Thread(
            target=self._heartbeat_loop,
            name="HeartbeatService",
            daemon=True,  # Daemon thread exits when main thread exits
        )
        self._thread.start()

        logger.info(
            f"[HeartbeatService] Started: type={self._heartbeat_type}, "
            f"id={self._heartbeat_id}, interval={self._interval}s, url={self._heartbeat_url}"
        )
        return True

    def stop(self) -> None:
        """Stop the heartbeat service."""
        if not self._running:
            return

        self._running = False
        logger.info("[HeartbeatService] Stopping...")

        # Wait for thread to finish (with timeout)
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)

        logger.info("[HeartbeatService] Stopped")

    def _heartbeat_loop(self) -> None:
        """Main heartbeat loop running in background thread."""
        consecutive_failures = 0
        max_failures = 5  # Log warning after consecutive failures

        while self._running:
            try:
                success = self._send_heartbeat()
                if success:
                    consecutive_failures = 0
                else:
                    consecutive_failures += 1
                    if consecutive_failures >= max_failures:
                        logger.warning(
                            f"[HeartbeatService] {consecutive_failures} consecutive "
                            f"heartbeat failures"
                        )
            except Exception as e:
                consecutive_failures += 1
                logger.error(f"[HeartbeatService] Heartbeat error: {e}")

            # Sleep in small intervals to allow quick shutdown
            for _ in range(self._interval * 2):  # Check every 0.5 seconds
                if not self._running:
                    break
                time.sleep(0.5)

    def _send_heartbeat(self) -> bool:
        """Send a single heartbeat to executor_manager.

        Returns:
            True if heartbeat was acknowledged, False otherwise
        """
        try:
            response = requests.post(
                self._heartbeat_url,
                json={
                    "heartbeat_id": self._heartbeat_id,
                    "heartbeat_type": self._heartbeat_type,
                    "timestamp": time.time(),
                },
                timeout=DEFAULT_HEARTBEAT_TIMEOUT,
            )

            if response.status_code == 200:
                logger.debug(
                    f"[HeartbeatService] Heartbeat sent: type={self._heartbeat_type}, "
                    f"id={self._heartbeat_id}"
                )

                # Check if response contains Claude configuration
                try:
                    response_data = response.json()
                    if (
                        not self._claude_initialized
                        and "claude_config" in response_data
                    ):
                        # Initialize Claude Code on first heartbeat if configuration is provided
                        self._initialize_claude(response_data["claude_config"])
                except Exception as e:
                    logger.warning(
                        f"[HeartbeatService] Failed to process Claude config: {e}"
                    )

                return True
            else:
                logger.warning(
                    f"[HeartbeatService] Heartbeat failed: status={response.status_code}, "
                    f"body={response.text}"
                )
                return False

        except requests.exceptions.Timeout:
            logger.warning("[HeartbeatService] Heartbeat timeout")
            return False
        except requests.exceptions.ConnectionError as e:
            logger.warning(f"[HeartbeatService] Connection error: {e}")
            return False
        except Exception as e:
            logger.error(f"[HeartbeatService] Unexpected error: {e}")
            return False

    def _initialize_claude(self, claude_config: dict) -> None:
        """Initialize Claude Code using configuration from heartbeat response.

        This method is called once when the first heartbeat receives Claude configuration.
        It creates the ClaudeCodeAgent and runs initialization to:
        - Save Claude settings to ~/.claude/settings.json
        - Save Claude user config to ~/.claude.json
        - Download and deploy skills to ~/.claude/skills/

        Args:
            claude_config: Claude configuration dict with bot, user, and team info
        """
        if self._claude_initialized:
            return

        try:
            logger.info(
                f"[HeartbeatService] Initializing Claude Code for sandbox {self._heartbeat_id}..."
            )

            # Import here to avoid circular dependencies
            from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
            from shared.status import TaskStatus

            # Create minimal task data for initialization
            init_task_data = {
                "task_id": (
                    int(self._heartbeat_id) if self._heartbeat_id.isdigit() else -1
                ),
                "subtask_id": -1,
                "bot": [claude_config.get("bot")],
                "user": claude_config.get("user", {}),
                "team": claude_config.get("team", {}),
            }

            # Create ClaudeCodeAgent instance
            agent = ClaudeCodeAgent(init_task_data)

            # Run initialization
            init_status = agent.initialize()

            if init_status == TaskStatus.SUCCESS:
                self._claude_initialized = True
                logger.info(
                    f"[HeartbeatService] Claude Code initialized successfully for sandbox {self._heartbeat_id}"
                )
            else:
                logger.warning(
                    f"[HeartbeatService] Claude Code initialization returned status: {init_status}"
                )

        except Exception as e:
            logger.error(
                f"[HeartbeatService] Failed to initialize Claude Code: {e}",
                exc_info=True,
            )


# Module-level functions for easy access
_heartbeat_service: Optional[HeartbeatService] = None


def get_heartbeat_service() -> HeartbeatService:
    """Get the global HeartbeatService instance.

    Returns:
        The HeartbeatService singleton
    """
    global _heartbeat_service
    if _heartbeat_service is None:
        _heartbeat_service = HeartbeatService.get_instance()
    return _heartbeat_service


def start_heartbeat() -> bool:
    """Start the heartbeat service.

    Convenience function to start the global heartbeat service instance.

    Returns:
        True if started successfully
    """
    return get_heartbeat_service().start()


def stop_heartbeat() -> None:
    """Stop the heartbeat service.

    Convenience function to stop the global heartbeat service instance.
    """
    get_heartbeat_service().stop()
