# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Callback client for sending events to backend.

This module provides a unified client for sending OpenAI Responses API format
events to the backend's callback endpoint. It is used by executor_manager
components that need to report task status changes (e.g., heartbeat timeout,
task queue failures).

The callback endpoint at /api/internal/callback handles:
- Updating task status in database
- Notifying frontend via WebSocket
- Publishing TaskCompletedEvent for subscription handling
"""

import os
from typing import Any, Dict, Optional

from shared.logger import setup_logger
from shared.models.responses_api import ResponsesAPIStreamEvents
from shared.utils.http_client import traced_async_client

logger = setup_logger(__name__)


class CallbackClient:
    """Client for sending callback events to backend.

    This client sends events in OpenAI Responses API format to the backend's
    unified callback endpoint. It supports sending error events for task
    failures detected by executor_manager (e.g., OOM, heartbeat timeout).

    Usage:
        client = CallbackClient()
        await client.send_error(
            task_id=123,
            subtask_id=456,
            error_message="Container OOM killed",
            executor_name="executor-123",
        )
    """

    def __init__(self, timeout: float = 30.0):
        """Initialize the callback client.

        Args:
            timeout: HTTP request timeout in seconds
        """
        self.timeout = timeout
        self._callback_url: Optional[str] = None

    @property
    def callback_url(self) -> str:
        """Get the backend callback URL."""
        if self._callback_url is None:
            task_api_domain = os.getenv("TASK_API_DOMAIN", "http://localhost:8000")
            self._callback_url = f"{task_api_domain}/api/internal/callback"
        return self._callback_url

    async def send_error(
        self,
        task_id: int,
        subtask_id: int,
        error_message: str,
        executor_name: Optional[str] = None,
        error_code: str = "executor_crash",
    ) -> bool:
        """Send error callback to backend.

        This method sends an ERROR event in OpenAI Responses API format,
        which will update the task status to FAILED and notify the frontend.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            error_message: Error message describing the failure
            executor_name: Optional executor container name
            error_code: Error code (default: "executor_crash")

        Returns:
            True if callback was sent successfully, False otherwise
        """
        event_data = {
            "event_type": ResponsesAPIStreamEvents.ERROR.value,
            "task_id": task_id,
            "subtask_id": subtask_id,
            "data": {
                "code": error_code,
                "message": error_message,
            },
        }

        if executor_name:
            event_data["executor_name"] = executor_name

        return await self._send_callback(event_data)

    async def _send_callback(self, event_data: Dict[str, Any]) -> bool:
        """Send callback event to backend.

        Args:
            event_data: Event data in OpenAI Responses API format

        Returns:
            True if callback was sent successfully, False otherwise
        """
        task_id = event_data.get("task_id", 0)
        event_type = event_data.get("event_type", "")

        try:
            async with traced_async_client(timeout=self.timeout) as client:
                response = await client.post(self.callback_url, json=event_data)
                if response.status_code == 200:
                    logger.info(
                        f"[CallbackClient] Sent {event_type} callback for task {task_id}"
                    )
                    return True
                else:
                    logger.warning(
                        f"[CallbackClient] Callback failed: "
                        f"{response.status_code} {response.text}"
                    )
                    return False
        except Exception as e:
            logger.error(f"[CallbackClient] Failed to send callback: {e}")
            return False


# Global singleton instance
_callback_client: Optional[CallbackClient] = None


def get_callback_client() -> CallbackClient:
    """Get the global CallbackClient instance.

    Returns:
        The CallbackClient singleton
    """
    global _callback_client
    if _callback_client is None:
        _callback_client = CallbackClient()
    return _callback_client
