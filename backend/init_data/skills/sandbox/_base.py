# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Common E2B sandbox utilities for sandbox tools.

This module provides shared functionality for tools that need to interact
with E2B sandboxes, including:
- E2B SDK patching for Wegent protocol (path-based routing)
- Sandbox creation and lifecycle management
- Environment configuration

All tools (command_tool, file_list_tool, file_read_tool, file_write_tool, etc.)
should import from this module to ensure consistent E2B SDK behavior.
"""

import asyncio
import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Default configuration
DEFAULT_EXECUTOR_MANAGER_URL = "http://localhost:8001"
DEFAULT_SANDBOX_TIMEOUT = 1800  # 30 minutes

# E2B SDK patching - must be done before any e2b imports
# Setup environment variables first
_executor_manager_url = os.getenv("EXECUTOR_MANAGER_URL", DEFAULT_EXECUTOR_MANAGER_URL)
os.environ["E2B_API_URL"] = _executor_manager_url.rstrip("/") + "/executor-manager/e2b"
os.environ["E2B_API_KEY"] = os.getenv(
    "E2B_API_KEY", "test-api-key"
)  # Default matches executor_manager

# Enable debug mode for HTTP
if os.environ["E2B_API_URL"].startswith("http://"):
    os.environ["E2B_DEBUG"] = "true"

# Track whether E2B SDK has been patched
_e2b_patched = False


def patch_e2b_sdk() -> bool:
    """Patch E2B SDK for Wegent protocol (path-based routing).

    This function patches the E2B SDK to work with Wegent's path-based routing
    instead of E2B's default subdomain-based routing.

    Original E2B format:  <port>-<sandboxID>.E2B_DOMAIN
    Wegent protocol:      domain/executor-manager/e2b/proxy/<sandboxID>/<port>

    Returns:
        True if patching succeeded, False if E2B SDK is not available
    """
    global _e2b_patched

    if _e2b_patched:
        logger.debug("[E2BSandbox] E2B SDK already patched")
        return True

    try:
        import httpx
        from e2b import ConnectionConfig
        from e2b.api.client_async import AsyncTransportWithLogger
        from e2b.api.client_sync import TransportWithLogger
        from e2b.sandbox.main import SandboxBase

        # Define patch functions at module level (not nested)
        def _patched_sandbox_get_host(self, port: int) -> str:
            """Get host for sandbox using Wegent path-based routing.

            Original E2B format:  <port>-<sandboxID>.E2B_DOMAIN
            Wegent protocol:      domain/executor-manager/e2b/proxy/<sandboxID>/<port>
            """
            domain = self.sandbox_domain
            if domain.startswith("http://"):
                domain = domain[7:]
            elif domain.startswith("https://"):
                domain = domain[8:]
            return f"{domain}/executor-manager/e2b/proxy/{self.sandbox_id}/{port}"

        def _patched_connection_config_get_host(
            self, sandbox_id: str, sandbox_domain: str, port: int
        ) -> str:
            """Get host for connection using Wegent path-based routing."""
            domain = sandbox_domain
            if domain.startswith("http://"):
                domain = domain[7:]
            elif domain.startswith("https://"):
                domain = domain[8:]
            return f"{domain}/executor-manager/e2b/proxy/{sandbox_id}/{port}"

        def _patched_connection_config_get_sandbox_url(
            self, sandbox_id: str, sandbox_domain: str
        ) -> str:
            """Get full sandbox URL for Wegent path-based routing.

            This method constructs the complete URL including protocol and port,
            ensuring SDK logs show the correct full URL.

            sandbox_domain from server includes protocol (e.g., "http://127.0.0.1:8001")
            """
            # sandbox_domain already includes protocol, use it directly
            domain = sandbox_domain
            # Ensure we have a protocol
            if not domain.startswith("http://") and not domain.startswith("https://"):
                domain = f"{'http' if self.debug else 'https'}://{domain}"
            return f"{domain}/executor-manager/e2b/proxy/{sandbox_id}/{self.envd_port}"

        def _build_url_with_port(request) -> str:
            """Build URL string with port for logging.

            E2B SDK's TransportWithLogger has a bug where it doesn't include the port
            in the logged URL. This helper function fixes that.
            """
            port = request.url.port
            port_str = f":{port}" if port and port not in (80, 443) else ""
            return (
                f"{request.url.scheme}://{request.url.host}{port_str}{request.url.path}"
            )

        def _patched_sync_transport_handle_request(self, request):
            """Patched sync transport handler with correct URL logging."""
            _logger = logging.getLogger("e2b.api.client_sync")

            url = _build_url_with_port(request)
            _logger.info(f"Request: {request.method} {url}")

            response = httpx.HTTPTransport.handle_request(self, request)

            _logger.info(f"Response: {response.status_code} {url}")
            return response

        async def _patched_async_transport_handle_request(self, request):
            """Patched async transport handler with correct URL logging."""
            _logger = logging.getLogger("e2b.api.client_async")

            url = _build_url_with_port(request)
            _logger.info(f"Request: {request.method} {url}")

            response = await httpx.AsyncHTTPTransport.handle_async_request(
                self, request
            )

            _logger.info(f"Response: {response.status_code} {url}")
            return response

        # Apply patches immediately at module load time
        SandboxBase.get_host = _patched_sandbox_get_host
        ConnectionConfig.get_host = _patched_connection_config_get_host
        ConnectionConfig.get_sandbox_url = _patched_connection_config_get_sandbox_url
        TransportWithLogger.handle_request = _patched_sync_transport_handle_request
        AsyncTransportWithLogger.handle_async_request = (
            _patched_async_transport_handle_request
        )

        logger.info("[E2BSandbox] E2B SDK patched for Wegent protocol")
        _e2b_patched = True
        return True

    except ImportError as e:
        logger.warning(f"[E2BSandbox] E2B SDK not available: {e}")
        _e2b_patched = False
        return False


class SandboxManager:
    """Manager for E2B sandbox lifecycle (Singleton per task_id).

    This class provides common sandbox operations for all tools that need
    to interact with E2B sandboxes. It handles:
    - Sandbox creation with proper metadata
    - Timeout management
    - Error handling
    - Singleton pattern per task_id

    Note: Sandboxes are NOT cached/reused to avoid stale reference issues.
    Each get_or_create_sandbox() call creates a fresh sandbox instance.

    Usage:
        manager = SandboxManager.get_instance(
            task_id=123,
            user_id=456,
            user_name="test_user"
        )
        sandbox, error = await manager.get_or_create_sandbox(
            shell_type="ClaudeCode",
            workspace_ref="my-repo"
        )
        if error:
            # Handle error
            pass
        else:
            # Use sandbox
            pass
    """

    # Class-level dictionary to store singleton instances per task_id
    _instances: dict[int, "SandboxManager"] = {}
    _lock = asyncio.Lock()

    def __init__(
        self,
        task_id: int,
        user_id: int,
        user_name: str,
        timeout: int = DEFAULT_SANDBOX_TIMEOUT,
        bot_config: list = None,
    ):
        """Initialize sandbox manager.

        Note: Don't call this directly, use get_instance() instead.

        Args:
            task_id: Task ID for sandbox metadata
            user_id: User ID for sandbox metadata
            user_name: Username for sandbox metadata
            timeout: Sandbox timeout in seconds (default: 30 minutes)
            bot_config: Bot configuration list (optional)
        """
        self.task_id = task_id
        self.user_id = user_id
        self.user_name = user_name
        self.timeout = timeout
        self.bot_config = bot_config or []

        # Ensure E2B SDK is patched
        patch_e2b_sdk()

    @classmethod
    def get_instance(
        cls,
        task_id: int,
        user_id: int,
        user_name: str,
        timeout: int = DEFAULT_SANDBOX_TIMEOUT,
        bot_config: list = None,
    ) -> "SandboxManager":
        """Get or create a singleton SandboxManager instance for the given task_id.

        Args:
            task_id: Task ID for sandbox metadata
            user_id: User ID for sandbox metadata
            user_name: Username for sandbox metadata
            timeout: Sandbox timeout in seconds (default: 30 minutes)
            bot_config: Bot configuration list (optional)

        Returns:
            SandboxManager instance for the task_id
        """
        if task_id not in cls._instances:
            logger.info(f"[SandboxManager] Creating new instance for task_id={task_id}")
            cls._instances[task_id] = cls(
                task_id, user_id, user_name, timeout, bot_config
            )
        else:
            logger.debug(
                f"[SandboxManager] Reusing existing instance for task_id={task_id}"
            )
        return cls._instances[task_id]

    @classmethod
    def remove_instance(cls, task_id: int) -> None:
        """Remove the SandboxManager instance for the given task_id.

        This should be called when the task is completed to clean up resources.

        Args:
            task_id: Task ID to remove
        """
        if task_id in cls._instances:
            logger.info(f"[SandboxManager] Removing instance for task_id={task_id}")
            # Kill sandbox if exists
            instance = cls._instances[task_id]
            instance.kill_sandbox()
            del cls._instances[task_id]

    async def get_or_create_sandbox(
        self,
        shell_type: str,
        workspace_ref: Optional[str] = None,
        task_type: str = "sandbox",
    ) -> tuple[Any, Optional[str]]:
        """Create a fresh sandbox instance using E2B SDK.

        Always creates a new sandbox to avoid issues with destroyed sandbox instances.
        This ensures sandbox reliability and prevents access errors when sandboxes
        are unexpectedly terminated.

        Args:
            shell_type: Execution environment type (e.g., "ClaudeCode", "Agno")
            workspace_ref: Optional workspace reference
            task_type: Task type for metadata (default: "generic")

        Returns:
            Tuple of (sandbox_instance, error_message or None)
        """
        # Always create a fresh sandbox to prevent stale reference issues
        logger.info(
            f"[SandboxManager] Creating sandbox: shell_type={shell_type}, "
            f"user={self.user_name}, task_type={task_type}"
        )

        try:
            # Import E2B SDK async version (patched at this point)
            import json

            from e2b_code_interpreter import AsyncSandbox

            # Prepare metadata with bot_config if available
            # Note: E2B SDK metadata type is Dict[str, str], so we need to serialize complex values
            metadata = {
                "task_type": task_type,
                "task_id": str(self.task_id),
                "user_id": str(self.user_id),
                "user_name": self.user_name,
            }

            if workspace_ref:
                metadata["workspace_ref"] = workspace_ref

            # Serialize bot_config to JSON string if available
            # E2B SDK only accepts string values in metadata
            if self.bot_config:
                metadata["bot_config"] = json.dumps(self.bot_config, ensure_ascii=False)

            # Use native async API - no need for run_in_executor
            sandbox = await AsyncSandbox.create(
                template=shell_type,
                timeout=self.timeout,
                metadata=metadata,
            )

            logger.info(f"[SandboxManager] Sandbox created: {sandbox.sandbox_id}")
            return sandbox, None

        except Exception as e:
            logger.error(
                f"[SandboxManager] Sandbox creation failed: {e}", exc_info=True
            )
            return None, str(e)

    def kill_sandbox(self) -> None:
        """Kill sandbox (no-op since sandboxes are not cached).

        Sandboxes are managed by executor_manager and will be automatically
        cleaned up based on timeout or task completion.
        """
        logger.debug(
            f"[SandboxManager] kill_sandbox called for task_id={self.task_id} (no-op)"
        )

    @property
    def sandbox_id(self) -> Optional[str]:
        """Get current sandbox ID (always None since no caching).

        Returns:
            None (sandboxes are not cached)
        """
        return None


# Patch E2B SDK at module load time
patch_e2b_sdk()


# Import BaseTool for base class definition
try:
    from langchain_core.tools import BaseTool

    class BaseSandboxTool(BaseTool):
        """Base class for Sandbox tools with common dependencies and configuration.

        This base class provides common attributes and sandbox management for all
        tools that need to interact with E2B sandboxes. Subclasses should override
        the specific tool methods (_run, _arun) to implement their functionality.

        Attributes:
            task_id: Task ID for sandbox metadata
            subtask_id: Subtask ID for sandbox metadata
            ws_emitter: WebSocket emitter for status updates
            user_id: User ID for sandbox metadata
            user_name: Username for sandbox metadata
            bot_config: Bot configuration list
            default_shell_type: Default shell type (ClaudeCode, Agno, etc.)
            timeout: Execution timeout in seconds
        """

        # Injected dependencies - set when creating the tool instance
        task_id: int = 0
        subtask_id: int = 0
        ws_emitter: Any = None
        user_id: int = 0
        user_name: str = ""
        bot_config: list = []  # Bot config list [{shell_type, agent_config}, ...]

        # Configuration
        default_shell_type: str = "ClaudeCode"
        timeout: int = 7200  # 2 hours default

        # Sandbox manager - handles sandbox lifecycle
        _sandbox_manager: Any = None  # SandboxManager instance

        class Config:
            arbitrary_types_allowed = True

        def _get_sandbox_manager(self) -> SandboxManager:
            """Get or create sandbox manager for this tool instance using singleton pattern.

            Returns:
                SandboxManager singleton instance for this task
            """
            return SandboxManager.get_instance(
                task_id=self.task_id,
                user_id=self.user_id,
                user_name=self.user_name,
                timeout=DEFAULT_SANDBOX_TIMEOUT,
                bot_config=self.bot_config,
            )

        def kill_sandbox(self) -> None:
            """Kill the cached sandbox if it exists."""
            # Get the singleton instance and kill its sandbox
            manager = SandboxManager.get_instance(
                task_id=self.task_id,
                user_id=self.user_id,
                user_name=self.user_name,
            )
            manager.kill_sandbox()

        def _format_error(self, error_message: str, **kwargs) -> str:
            """Format error response as JSON string.

            Args:
                error_message: Error description
                **kwargs: Additional fields to include in response (e.g., stdout, stderr, exit_code)

            Returns:
                JSON string with error information
            """
            import json

            response = {
                "success": False,
                "error": error_message,
            }

            # Add any additional fields provided
            response.update(kwargs)

            # Add suggestion if not provided
            if "suggestion" not in response:
                response["suggestion"] = (
                    "The operation could not be completed. "
                    "Please check the error message and try again."
                )

            return json.dumps(response, ensure_ascii=False, indent=2)

        async def _emit_tool_status(
            self, status: str, message: str = "", result: dict = None
        ) -> None:
            """Emit tool status update to frontend via WebSocket.

            Args:
                status: Status string ("completed", "failed", "running", etc.)
                message: Optional status message
                result: Optional result data for completed status
            """
            if not self.ws_emitter:
                return

            try:
                tool_output = {"message": message}
                if result:
                    tool_output.update(result)

                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={},
                    tool_output=tool_output,
                    status=status,
                )
            except Exception as e:
                logger.warning(
                    f"[{self.__class__.__name__}] Failed to emit tool status: {e}"
                )

except ImportError:
    # If langchain_core is not available, define a placeholder
    logger.warning(
        "[BaseSandboxTool] langchain_core not available, BaseSandboxTool not defined"
    )
    BaseSandboxTool = None
