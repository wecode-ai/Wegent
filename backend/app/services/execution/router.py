# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Execution router for task dispatch.

Routes tasks to execution targets based on configuration.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from app.core.config import settings
from shared.models import ExecutionRequest


class CommunicationMode(str, Enum):
    """Communication mode for execution services."""

    SSE = "sse"  # Active request with long connection
    WEBSOCKET = "websocket"  # Passive request with long connection
    HTTP_CALLBACK = "http_callback"  # HTTP + Callback
    POLLING = "polling"  # Create job + poll status + stream results


@dataclass
class ExecutionTarget:
    """Execution target configuration."""

    mode: CommunicationMode
    # For SSE/HTTP mode
    url: Optional[str] = None
    # For WebSocket mode
    namespace: Optional[str] = None
    event: str = "task:execute"
    room: Optional[str] = None  # WebSocket room (e.g., device:{user_id}:{device_id})


class ExecutionRouter:
    """Execution router.

    Routes tasks to execution targets based on configuration.

    Design principles:
    - Does not care what the execution service is (device? executor? chat_shell?)
    - Only cares about communication mode and target address
    """

    # Execution service configuration
    # Backend only knows communication mode and target address
    EXECUTION_SERVICES: dict = {
        # SSE mode services
        "Chat": {
            "mode": "sse",
            "url": None,  # Will be set from settings
            "endpoint": "/v1/responses",  # OpenAI Responses API compatible endpoint
        },
        # HTTP+Callback mode services
        "ClaudeCode": {
            "mode": "http_callback",
            "url": None,  # Will be set from settings
        },
        "Agno": {
            "mode": "http_callback",
            "url": None,
        },
        "Dify": {
            "mode": "http_callback",
            "url": None,
        },
    }

    def __init__(self):
        """Initialize the execution router."""
        # Initialize URLs from settings
        self._init_service_urls()

    def _init_service_urls(self) -> None:
        """Initialize service URLs from settings."""
        chat_shell_url = getattr(settings, "CHAT_SHELL_URL", "http://127.0.0.1:8100")
        executor_manager_url = getattr(
            settings, "EXECUTOR_MANAGER_URL", "http://127.0.0.1:8001"
        )

        self.EXECUTION_SERVICES["Chat"]["url"] = chat_shell_url
        self.EXECUTION_SERVICES["ClaudeCode"]["url"] = (
            executor_manager_url + "/executor-manager"
        )
        self.EXECUTION_SERVICES["Agno"]["url"] = (
            executor_manager_url + "/executor-manager"
        )
        self.EXECUTION_SERVICES["Dify"]["url"] = (
            executor_manager_url + "/executor-manager"
        )

    def route(
        self,
        request: ExecutionRequest,
        device_id: Optional[str] = None,
    ) -> ExecutionTarget:
        """Route task to execution target.

        Routing priority:
        0. Model type based routing (e.g., video models -> POLLING)
        1. Protocol-based routing (e.g., gemini-deep-research -> POLLING)
        2. If device_id is specified, use WebSocket mode
        3. Otherwise, look up configuration by shell_type
        4. Default to HTTP+Callback mode

        Args:
            request: Execution request
            device_id: Optional device ID (uses WebSocket mode when specified)

        Returns:
            ExecutionTarget with routing information
        """
        user_id = request.user.get("id") if request.user else None

        # Priority 0: Model type based routing for polling agents
        model_type = self._get_model_type(request)
        if model_type == "video" and not device_id:
            return ExecutionTarget(
                mode=CommunicationMode.POLLING,
            )

        # Priority 1: Protocol-based routing (e.g., gemini-deep-research)
        protocol = (
            request.model_config.get("protocol") if request.model_config else None
        )
        if protocol == "gemini-deep-research" and not device_id:
            return ExecutionTarget(
                mode=CommunicationMode.POLLING,
            )

        # Priority 1: device_id specified, use WebSocket mode
        if device_id:
            return ExecutionTarget(
                mode=CommunicationMode.WEBSOCKET,
                namespace="/local-executor",
                event="task:execute",
                room=f"device:{user_id}:{device_id}",
            )

        # Priority 2: Look up configuration by shell_type
        shell_type = self._get_shell_type(request)
        service_config = self.EXECUTION_SERVICES.get(shell_type)

        if service_config:
            mode = CommunicationMode(service_config["mode"])
            if mode == CommunicationMode.WEBSOCKET:
                return ExecutionTarget(
                    mode=mode,
                    namespace=service_config.get("namespace"),
                    event=service_config.get("event", "task:execute"),
                )
            else:
                # SSE or HTTP+Callback
                return ExecutionTarget(
                    mode=mode,
                    url=service_config["url"],
                )

        # Priority 3: Default configuration
        default_url = (
            getattr(settings, "EXECUTOR_MANAGER_URL", "http://127.0.0.1:8001")
            + "/executor-manager"
        )
        return ExecutionTarget(
            mode=CommunicationMode.HTTP_CALLBACK,
            url=default_url,
        )

    def _get_shell_type(self, request: ExecutionRequest) -> str:
        """Get shell_type from request.

        Args:
            request: Execution request

        Returns:
            Shell type string (default: "Chat")
        """
        if request.bot and len(request.bot) > 0:
            return request.bot[0].get("shell_type", "Chat")
        return "Chat"

    def _get_model_type(self, request: ExecutionRequest) -> Optional[str]:
        """Get model type from request.

        Args:
            request: Execution request

        Returns:
            Model type string (e.g., 'video', 'llm') or None
        """
        if request.model_config:
            return request.model_config.get("modelType")
        return None
