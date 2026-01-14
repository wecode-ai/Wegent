# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SubAgent task creation tool using E2B SDK.

This tool allows Chat Shell agents to create SubAgent tasks that run
in isolated Docker environments (ClaudeCode or Agno) using the E2B SDK
for sandbox lifecycle management.

E2B SDK Flow:
1. Patch E2B SDK for Wegent protocol (path-based routing)
2. Create sandbox using Sandbox.create()
3. Send task via sandbox.run_code() - returns task_url
4. Poll for results until completion
5. Optionally keep sandbox alive or terminate
"""

import asyncio
import json
import logging
import os
import time
from typing import Any, Optional

import httpx
from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Default configuration
DEFAULT_EXECUTOR_MANAGER_URL = "http://localhost:8001"
DEFAULT_SANDBOX_TIMEOUT = 1800  # 30 minutes
DEFAULT_EXECUTION_TIMEOUT = 7200  # 2 hours
POLL_INTERVAL = 2  # seconds between polls
MAX_POLL_COUNT = 3600  # max polls (2 hours at 2s interval)

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

# Import E2B SDK classes for patching
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
        return f"{request.url.scheme}://{request.url.host}{port_str}{request.url.path}"

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

        response = await httpx.AsyncHTTPTransport.handle_async_request(self, request)

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

    logger.info("[SubAgentTool] E2B SDK patched for Wegent protocol")
    _e2b_patched = True

except ImportError as e:
    logger.warning(f"[SubAgentTool] E2B SDK not available, will fail at runtime: {e}")
    _e2b_patched = False


class CreateSubAgentTaskInput(BaseModel):
    """Input schema for create_subagent_task tool."""

    task_prompt: str = Field(
        ...,
        description="Detailed description of the task for the SubAgent to execute. "
        "Be specific about what needs to be done, including file paths, "
        "expected outcomes, and any constraints.",
    )
    shell_type: Optional[str] = Field(
        default=None,
        description="Execution environment type: 'ClaudeCode' (default) for "
        "complex code tasks with Claude Code SDK, or 'Agno' for "
        "multi-agent collaboration scenarios.",
    )
    workspace_ref: Optional[str] = Field(
        default=None,
        description="Name of the Workspace (code repository) the SubAgent "
        "should work with. Required for tasks involving repository "
        "code modification.",
    )


class CreateSubAgentTaskTool(BaseTool):
    """Tool for creating SubAgent tasks using E2B SDK.

    This tool delegates complex tasks to SubAgents running in Docker containers.
    It uses the E2B SDK for:
    - Sandbox lifecycle management (create, keep-alive, terminate)
    - Execution management (run_code, poll status)
    - Automatic sandbox reuse within the same task context

    Supported task types:
    - Code generation and execution
    - File reading, writing, and modification
    - Git repository operations (clone, commit, push, etc.)
    - Complex multi-step programming tasks
    """

    name: str = "create_subagent_task"
    display_name: str = "Create SubAgent"
    description: str = """Create a SubAgent task to execute complex operations in an isolated environment.

Use this tool when you need to:
- Execute code or scripts
- Read, write, or modify files in a repository
- Perform Git operations (clone, commit, push, etc.)
- Run multi-step programming tasks

The SubAgent runs in an isolated Docker container with full code execution capabilities.

Parameters:
- task_prompt (required): Detailed task description for the SubAgent
- shell_type (optional): "ClaudeCode" (default) or "Agno"
- workspace_ref (optional): Repository name if working with code

Returns:
- On success: The execution result from the SubAgent
- On failure: Error message explaining what went wrong

Note: This operation may take several minutes for complex tasks."""

    args_schema: type[BaseModel] = CreateSubAgentTaskInput

    # Injected dependencies - set when creating the tool instance
    task_id: int = 0
    subtask_id: int = 0
    ws_emitter: Any = None
    user_id: int = 0
    user_name: str = ""
    bot_config: list = []  # Bot config list [{shell_type, agent_config}, ...]

    # Configuration
    default_shell_type: str = "ClaudeCode"
    timeout: int = DEFAULT_EXECUTION_TIMEOUT

    # Sandbox management - cache sandbox instance
    _sandbox: Any = None  # Cached E2B Sandbox instance
    _sandbox_shell_type: Optional[str] = None  # Track shell type for reuse check

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        task_prompt: str,
        shell_type: Optional[str] = None,
        workspace_ref: Optional[str] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError(
            "CreateSubAgentTaskTool only supports async execution"
        )

    async def _arun(
        self,
        task_prompt: str,
        shell_type: Optional[str] = None,
        workspace_ref: Optional[str] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute SubAgent task using E2B SDK.

        This method:
        1. Gets or creates a sandbox using E2B SDK
        2. Sends task via run_code and gets task_url
        3. Polls for completion
        4. Returns the result

        Args:
            task_prompt: Detailed task description for the SubAgent
            shell_type: Execution environment type ("ClaudeCode" or "Agno")
            workspace_ref: Optional workspace name for repository access
            run_manager: Callback manager

        Returns:
            JSON string with execution result
        """
        logger.info(
            f"[SubAgentTool] ===== _ARUN START ===== task_id={self.task_id}, "
            f"subtask_id={self.subtask_id}, shell_type={shell_type or self.default_shell_type}, "
            f"workspace_ref={workspace_ref}, "
            f"has_bot_config={bool(self.bot_config)}, "
            f"task_prompt_length={len(task_prompt)}"
        )

        # Validate shell_type
        effective_shell_type = shell_type or self.default_shell_type
        if effective_shell_type not in ["ClaudeCode", "Agno"]:
            logger.warning(
                f"[SubAgentTool] Invalid shell_type '{effective_shell_type}', "
                f"using default '{self.default_shell_type}'"
            )
            effective_shell_type = self.default_shell_type

        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "task_prompt": (
                            task_prompt[:200] + "..."
                            if len(task_prompt) > 200
                            else task_prompt
                        ),
                        "shell_type": effective_shell_type,
                        "workspace_ref": workspace_ref,
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(f"[SubAgentTool] Failed to emit tool status: {e}")

        try:
            # E2B SDK is patched at module load time, just import and use
            from e2b_code_interpreter import Sandbox

            # Step 1: Get or create sandbox
            logger.info(f"[SubAgentTool] STEP 1: Getting or creating sandbox...")
            sandbox, error = await self._get_or_create_sandbox(
                Sandbox=Sandbox,
                shell_type=effective_shell_type,
                workspace_ref=workspace_ref,
            )

            if error:
                logger.error(f"[SubAgentTool] STEP 1 FAILED: {error}")
                result = self._format_error(f"Failed to create sandbox: {error}")
                await self._emit_tool_status("failed", error)
                return result

            logger.info(
                f"[SubAgentTool] STEP 1 RESULT: sandbox_id={sandbox.sandbox_id}"
            )

            # Step 2: Execute task via run_code
            logger.info(
                f"[SubAgentTool] STEP 2: Sending task to sandbox {sandbox.sandbox_id}..."
            )
            result = await self._execute_task(
                sandbox=sandbox,
                task_prompt=task_prompt,
                workspace_ref=workspace_ref,
            )
            logger.info(f"[SubAgentTool] STEP 2 COMPLETE: result length={len(result)}")

            # Parse result to determine success/failure for status notification
            try:
                result_data = json.loads(result)
                if result_data.get("success"):
                    await self._emit_tool_status(
                        "completed", "Task completed successfully", result_data
                    )
                else:
                    await self._emit_tool_status(
                        "failed", result_data.get("error", "Task failed"), result_data
                    )
            except json.JSONDecodeError:
                await self._emit_tool_status("completed", "Task completed")
            return result

        except ImportError as e:
            logger.error(
                f"[SubAgentTool] E2B SDK import error: {e}",
                exc_info=True,
            )
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            await self._emit_tool_status("failed", error_msg)
            return self._format_error(error_msg)
        except Exception as e:
            logger.error(
                f"[SubAgentTool] Unexpected error: task_id={self.task_id}, error={e}, type={type(e).__name__}",
                exc_info=True,
            )
            error_msg = f"Unexpected error: {e}"
            await self._emit_tool_status("failed", error_msg)
            return self._format_error(error_msg)

    async def _get_or_create_sandbox(
        self,
        Sandbox,
        shell_type: str,
        workspace_ref: Optional[str],
    ) -> tuple[Any, Optional[str]]:
        """Get existing sandbox or create a new one using E2B SDK.

        Sandboxes are reused within the same task context if shell_type matches.

        Args:
            Sandbox: E2B Sandbox class
            shell_type: Execution environment type
            workspace_ref: Optional workspace reference

        Returns:
            Tuple of (sandbox_instance, error_message or None)
        """
        # Check if we have an existing sandbox with matching shell_type
        if self._sandbox and self._sandbox_shell_type == shell_type:
            try:
                # Try to extend sandbox timeout to verify it's still alive
                self._sandbox.set_timeout(DEFAULT_SANDBOX_TIMEOUT)
                logger.info(
                    f"[SubAgentTool] Reusing existing sandbox: {self._sandbox.sandbox_id}"
                )
                return self._sandbox, None
            except Exception as e:
                logger.warning(f"[SubAgentTool] Failed to reuse sandbox: {e}")
                self._sandbox = None
                self._sandbox_shell_type = None

        # Create new sandbox using E2B SDK
        logger.info(
            f"[SubAgentTool] Creating sandbox: shell_type={shell_type}, "
            f"user={self.user_name}"
        )

        try:
            # Run sandbox creation in thread pool since E2B SDK is sync
            loop = asyncio.get_event_loop()
            sandbox = await loop.run_in_executor(
                None,
                lambda: Sandbox.create(
                    template=shell_type,
                    timeout=DEFAULT_SANDBOX_TIMEOUT,
                    metadata={
                        "task_type": "subagent",  # Required for proxy routing
                        "task_id": self.task_id,
                        "user_id": self.user_id,
                        "user_name": self.user_name,
                        "workspace_ref": workspace_ref,
                    },
                ),
            )

            # Cache sandbox for reuse
            self._sandbox = sandbox
            self._sandbox_shell_type = shell_type

            logger.info(f"[SubAgentTool] Sandbox created: {sandbox.sandbox_id}")
            return sandbox, None

        except Exception as e:
            logger.error(f"[SubAgentTool] Sandbox creation failed: {e}", exc_info=True)
            return None, str(e)

    async def _execute_task(
        self,
        sandbox,
        task_prompt: str,
        workspace_ref: Optional[str],
    ) -> str:
        """Execute task via E2B SDK run_code and poll for results.

        Args:
            sandbox: E2B Sandbox instance
            task_prompt: Task prompt to execute
            workspace_ref: Optional workspace reference

        Returns:
            JSON string with execution result
        """
        start_time = time.time()

        # Construct subagent task body
        subagent_task = {
            "task_prompt": task_prompt,
            "subtask_id": self.subtask_id,
            "workspace_ref": workspace_ref,
            "timeout": self.timeout,
            "bot_config": self.bot_config if self.bot_config else None,
        }

        code_json = json.dumps(subagent_task, ensure_ascii=False)
        logger.info(
            f"[SubAgentTool] Sending task: sandbox_id={sandbox.sandbox_id}, "
            f"prompt_length={len(task_prompt)}"
        )

        try:
            # Run code in thread pool since E2B SDK is sync
            loop = asyncio.get_event_loop()
            execution = await loop.run_in_executor(
                None,
                lambda: sandbox.run_code(code_json),
            )

            logger.info(
                f"[SubAgentTool] run_code response: text={execution.text[:200] if execution.text else None}..."
            )

            # Check for immediate errors
            if execution.text is None:
                if execution.error:
                    return self._format_error(
                        f"{execution.error.name}: {execution.error.value}"
                    )
                return self._format_error("No response from sandbox")

            # Parse task_url from response
            try:
                task_info = json.loads(execution.text)
                task_url = task_info.get("task_url")

                if not task_url:
                    # Might be direct result
                    logger.info("[SubAgentTool] No task_url, treating as direct result")
                    return self._format_success(
                        {
                            "status": "success",
                            "result": execution.text,
                            "execution_time": time.time() - start_time,
                            "sandbox_id": sandbox.sandbox_id,
                        }
                    )

                logger.info(f"[SubAgentTool] Got task_url: {task_url}")

                # Poll for results
                return await self._poll_for_results(
                    task_url=task_url,
                    sandbox_id=sandbox.sandbox_id,
                    start_time=start_time,
                )

            except json.JSONDecodeError:
                # Direct result (not JSON with task_url)
                return self._format_success(
                    {
                        "status": "success",
                        "result": execution.text,
                        "execution_time": time.time() - start_time,
                        "sandbox_id": sandbox.sandbox_id,
                    }
                )

        except Exception as e:
            logger.error(f"[SubAgentTool] run_code failed: {e}", exc_info=True)
            return self._format_error(f"Execution failed: {e}")

    async def _poll_for_results(
        self,
        task_url: str,
        sandbox_id: str,
        start_time: float,
    ) -> str:
        """Poll for task completion.

        Args:
            task_url: URL to poll for results
            sandbox_id: Sandbox ID for logging
            start_time: Task start time

        Returns:
            JSON string with execution result
        """
        poll_count = 0

        async with httpx.AsyncClient(timeout=30.0) as client:
            while poll_count < MAX_POLL_COUNT:
                poll_count += 1
                elapsed = time.time() - start_time

                # Check timeout
                if elapsed > self.timeout:
                    logger.warning(
                        f"[SubAgentTool] Execution timeout: sandbox_id={sandbox_id}, "
                        f"elapsed={elapsed:.1f}s"
                    )
                    return self._format_success(
                        {
                            "status": "timeout",
                            "error_message": f"Execution timed out after {self.timeout} seconds",
                            "execution_time": elapsed,
                            "sandbox_id": sandbox_id,
                        }
                    )

                try:
                    response = await client.get(task_url)
                    data = response.json()

                    status = data.get("status", "unknown")
                    progress = data.get("progress", 0)

                    logger.debug(
                        f"[SubAgentTool] Poll [{poll_count}]: status={status}, "
                        f"progress={progress}%, elapsed={elapsed:.1f}s"
                    )

                    if status == "completed":
                        logger.info(
                            f"[SubAgentTool] Task completed: sandbox_id={sandbox_id}, "
                            f"elapsed={elapsed:.1f}s"
                        )
                        return self._format_success(
                            {
                                "status": "success",
                                "result": data.get("result"),
                                "execution_time": elapsed,
                                "sandbox_id": sandbox_id,
                            }
                        )

                    elif status == "failed":
                        logger.warning(
                            f"[SubAgentTool] Task failed: sandbox_id={sandbox_id}, "
                            f"error={data.get('error_message')}"
                        )
                        return self._format_success(
                            {
                                "status": "failed",
                                "error_message": data.get(
                                    "error_message", "Unknown error"
                                ),
                                "execution_time": elapsed,
                                "sandbox_id": sandbox_id,
                            }
                        )

                    elif status in ["pending", "running"]:
                        await asyncio.sleep(POLL_INTERVAL)

                    else:
                        logger.warning(f"[SubAgentTool] Unknown status: {status}")
                        await asyncio.sleep(POLL_INTERVAL)

                except httpx.RequestError as e:
                    logger.warning(f"[SubAgentTool] Poll request failed: {e}")
                    await asyncio.sleep(POLL_INTERVAL)

        # Max polls reached
        return self._format_error(
            f"Max poll count reached ({MAX_POLL_COUNT}), task may still be running"
        )

    def _format_success(self, result: dict) -> str:
        """Format successful execution result.

        Args:
            result: Response data

        Returns:
            JSON string with success message and result
        """
        status = result.get("status", "unknown")
        subagent_result = result.get("result", "")
        execution_time = result.get("execution_time", 0)
        sandbox_id = result.get("sandbox_id", "")

        if status == "success":
            response = {
                "success": True,
                "result": subagent_result,
                "execution_time_seconds": execution_time,
                "sandbox_id": sandbox_id,
                "message": (
                    f"SubAgent task completed successfully in {execution_time:.1f} seconds. "
                    "Review the result above and communicate relevant information to the user."
                ),
            }
        elif status == "timeout":
            response = {
                "success": False,
                "error": "SubAgent execution timed out",
                "partial_result": subagent_result,
                "execution_time_seconds": execution_time,
                "sandbox_id": sandbox_id,
                "suggestion": (
                    "The task took too long to complete. Consider: "
                    "1) Breaking the task into smaller steps, "
                    "2) Simplifying the requirements, "
                    "3) Trying a more specific task description."
                ),
            }
        else:
            # Failed or unknown status
            error_message = result.get("error_message", "Unknown error occurred")
            response = {
                "success": False,
                "error": error_message,
                "status": status,
                "sandbox_id": sandbox_id,
                "suggestion": (
                    "The SubAgent task failed. Review the error message and consider: "
                    "1) Checking if the workspace/repository exists, "
                    "2) Simplifying the task requirements, "
                    "3) Providing more specific instructions."
                ),
            }

        return json.dumps(response, ensure_ascii=False, indent=2)

    def _format_error(self, error_message: str) -> str:
        """Format error response.

        Args:
            error_message: Error description

        Returns:
            JSON string with error information
        """
        response = {
            "success": False,
            "error": error_message,
            "suggestion": (
                "The SubAgent task could not be executed. "
                "Inform the user about this issue and suggest alternatives: "
                "1) Try describing the task differently, "
                "2) Break down complex tasks into simpler steps, "
                "3) Check if the required resources (workspace, files) are available."
            ),
        }
        return json.dumps(response, ensure_ascii=False, indent=2)

    async def _emit_tool_status(
        self, status: str, message: str = "", result: dict = None
    ) -> None:
        """Emit tool status update to frontend via WebSocket.

        Args:
            status: Status string ("completed", "failed", etc.)
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
            logger.warning(f"[SubAgentTool] Failed to emit tool status: {e}")

    def kill_sandbox(self) -> None:
        """Kill the cached sandbox if it exists."""
        if self._sandbox:
            try:
                self._sandbox.kill()
                logger.info(
                    f"[SubAgentTool] Sandbox killed: {self._sandbox.sandbox_id}"
                )
            except Exception as e:
                logger.warning(f"[SubAgentTool] Failed to kill sandbox: {e}")
            finally:
                self._sandbox = None
                self._sandbox_shell_type = None
