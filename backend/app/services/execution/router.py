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
    INPROCESS = "inprocess"  # In-process execution (standalone mode)


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

    # Shell types that support in-process execution in standalone mode
    # ClaudeCode/Agno: executed via executor module
    INPROCESS_EXECUTOR_SHELL_TYPES = {"ClaudeCode", "Agno"}
    # Chat: executed via chat_shell module (when CHAT_SHELL_MODE=package)
    INPROCESS_CHAT_SHELL_TYPES = {"Chat"}

    def __init__(self):
        """Initialize the execution router."""
        import logging

        logger = logging.getLogger(__name__)
        # Initialize URLs from settings
        self._init_service_urls()
        # Check if standalone mode is enabled
        self.standalone_mode = getattr(settings, "STANDALONE_MODE", False)
        self.standalone_executor_enabled = getattr(
            settings, "STANDALONE_EXECUTOR_ENABLED", True
        )
        # Check if chat_shell is in package mode (in-process)
        self.chat_shell_mode = getattr(settings, "CHAT_SHELL_MODE", "http")
        logger.info(
            f"[ExecutionRouter] Initialized: standalone_mode={self.standalone_mode}, "
            f"standalone_executor_enabled={self.standalone_executor_enabled}, "
            f"chat_shell_mode={self.chat_shell_mode}"
        )

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
        1. If device_id is specified, use WebSocket mode
        2. In standalone mode with executor enabled, use INPROCESS for ClaudeCode/Agno
        3. If CHAT_SHELL_MODE=package, use INPROCESS for Chat shell type
        4. Otherwise, look up configuration by shell_type
        5. Default to HTTP+Callback mode

        Args:
            request: Execution request
            device_id: Optional device ID (uses WebSocket mode when specified)

        Returns:
            ExecutionTarget with routing information
        """
        import logging

        logger = logging.getLogger(__name__)
        user_id = request.user.get("id") if request.user else None

        # Priority 1: device_id specified, use WebSocket mode
        if device_id:
            return ExecutionTarget(
                mode=CommunicationMode.WEBSOCKET,
                namespace="/local-executor",
                event="task:execute",
                room=f"device:{user_id}:{device_id}",
            )

        shell_type = self._get_shell_type(request)
        logger.info(
            f"[ExecutionRouter.route] shell_type={shell_type}, "
            f"standalone_mode={self.standalone_mode}, "
            f"standalone_executor_enabled={self.standalone_executor_enabled}, "
            f"chat_shell_mode={self.chat_shell_mode}"
        )

        # Priority 2: Standalone mode with executor enabled, use INPROCESS for ClaudeCode/Agno
        if (
            self.standalone_mode
            and self.standalone_executor_enabled
            and shell_type in self.INPROCESS_EXECUTOR_SHELL_TYPES
        ):
            logger.info(f"[ExecutionRouter.route] Routing to INPROCESS mode (executor)")
            return ExecutionTarget(mode=CommunicationMode.INPROCESS)

        # Priority 3: Chat shell in package mode, use INPROCESS for Chat type
        if (
            self.chat_shell_mode == "package"
            and shell_type in self.INPROCESS_CHAT_SHELL_TYPES
        ):
            logger.info(
                f"[ExecutionRouter.route] Routing to INPROCESS mode (chat_shell package)"
            )
            return ExecutionTarget(mode=CommunicationMode.INPROCESS)

        # Priority 4: Look up configuration by shell_type
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

        # Priority 5: Default configuration
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
