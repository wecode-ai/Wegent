# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base class for browser automation tools using sandbox execution.

This module provides the base class for browser tools that execute
Playwright scripts in an isolated sandbox container. The base class
handles all sandbox interaction logic, so subclasses only need to
define their parameters and metadata.

Architecture:
- tools/ - Python tool definitions (sent to LLM)
- scripts/ - JS scripts executed in sandbox (Playwright Node.js API)

The base class automatically:
1. Gets or creates a sandbox
2. Ensures Playwright is installed
3. Executes the corresponding JS script with tool arguments
4. Parses and returns the result
"""

import base64
import json
import logging
import time
from typing import Any, ClassVar, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Default configuration
DEFAULT_BROWSER_TIMEOUT = 30  # 30 seconds
DEFAULT_ELEMENT_TIMEOUT = 10  # 10 seconds
SCREENSHOT_MAX_SIZE = 10485760  # 10MB


# Import BaseSandboxTool - use try/except to handle both direct and dynamic loading
try:
    # Try importing from chat_shell (for direct usage)
    from chat_shell.tools.sandbox import BaseSandboxTool
except ImportError:
    try:
        # Try relative import from sandbox skill (for dynamic loading)
        import sys

        # Try to find sandbox base module
        sandbox_base_module = sys.modules.get("skill_pkg_sandbox._base")
        if sandbox_base_module:
            BaseSandboxTool = sandbox_base_module.BaseSandboxTool
        else:
            # Fallback: try to import from chat_shell.tools.sandbox
            from chat_shell.tools.sandbox._base import BaseSandboxTool
    except ImportError as e:
        logger.error(f"[BaseBrowserTool] Cannot import BaseSandboxTool: {e}")
        raise ImportError(
            "BaseSandboxTool not available. "
            "Browser skill requires sandbox skill to be loaded first."
        )


class BaseBrowserTool(BaseSandboxTool):
    """Base class for Browser automation tools with sandbox execution.

    This base class provides unified sandbox execution logic for all browser tools.
    Subclasses only need to define:
    - name, display_name, description
    - args_schema (Pydantic model for tool parameters)
    - script_name (name of the JS script in scripts/ directory)

    The base class handles:
    - Sandbox creation and management
    - Playwright installation check
    - Script execution with argument passing
    - Result parsing and error handling
    - WebSocket status emission

    Attributes:
        task_id: Task ID for session tracking
        subtask_id: Subtask ID for session tracking
        ws_emitter: WebSocket emitter for status updates
        user_id: User ID for session metadata
        user_name: Username for session metadata
        default_timeout: Default timeout in seconds
        script_name: Name of the JS script to execute (without .js extension)
    """

    # Configuration - subclasses should override script_name
    default_timeout: int = DEFAULT_BROWSER_TIMEOUT
    script_name: ClassVar[str] = ""  # e.g., "navigate", "click", "fill", "screenshot"

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
        **kwargs: Any,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError(
            f"{self.__class__.__name__} only supports async execution"
        )

    async def _arun(
        self,
        run_manager: CallbackManagerForToolRun | None = None,
        **kwargs: Any,
    ) -> str:
        """Execute browser tool in sandbox.

        This method is called by LangChain when the tool is invoked.
        It handles all sandbox interaction and script execution.

        Args:
            run_manager: Callback manager
            **kwargs: Tool arguments (defined by args_schema)

        Returns:
            JSON string with execution result
        """
        start_time = time.time()

        # Get script name - use class attribute or derive from class name
        script_name = self.script_name
        if not script_name:
            # Derive from class name: BrowserNavigateTool -> navigate
            class_name = self.__class__.__name__
            if class_name.startswith("Browser"):
                class_name = class_name[7:]
            if class_name.endswith("Tool"):
                class_name = class_name[:-4]
            script_name = class_name.lower()

        logger.info(
            f"[{self.__class__.__name__}] Executing script={script_name}, args={kwargs}"
        )

        # Emit status update
        await self._emit_tool_status("running", f"Executing {script_name}...")

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                logger.error(
                    f"[{self.__class__.__name__}] Failed to create sandbox: {error}"
                )
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    execution_time=time.time() - start_time,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Ensure Playwright is installed
            success, error = await self._ensure_playwright_in_sandbox(sandbox)
            if not success:
                result = self._format_error(
                    error_message=error,
                    execution_time=time.time() - start_time,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Calculate timeout
            timeout = kwargs.pop("timeout_seconds", None) or self.default_timeout

            # Execute script in sandbox
            success, stdout, error = await self._run_browser_script(
                sandbox=sandbox,
                script_name=script_name,
                args=kwargs,
                timeout=timeout + 30,  # Add buffer for script overhead
            )

            execution_time = time.time() - start_time

            if not success:
                logger.error(f"[{self.__class__.__name__}] Script failed: {error}")
                result = self._format_error(
                    error_message=f"Script execution failed: {error}",
                    execution_time=execution_time,
                    **kwargs,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Parse result
            try:
                result_data = json.loads(stdout.strip())
                if not result_data.get("success"):
                    error_msg = result_data.get("error", "Unknown error")
                    result = self._format_error(
                        error_message=error_msg,
                        execution_time=execution_time,
                        **kwargs,
                    )
                    await self._emit_tool_status("failed", error_msg)
                    return result

                result_data["execution_time"] = execution_time
                result_data["sandbox_id"] = sandbox.sandbox_id

                logger.info(
                    f"[{self.__class__.__name__}] Completed: time={execution_time:.2f}s"
                )

                await self._emit_tool_status("completed", "Success", result_data)
                return json.dumps(result_data, ensure_ascii=False, indent=2)

            except json.JSONDecodeError:
                error_msg = f"Unexpected output: {stdout[:200]}"
                result = self._format_error(
                    error_message=error_msg,
                    execution_time=execution_time,
                    **kwargs,
                )
                await self._emit_tool_status("failed", error_msg)
                return result

        except Exception as e:
            logger.error(f"[{self.__class__.__name__}] Failed: {e}", exc_info=True)
            error_msg = f"Execution failed: {e}"
            result = self._format_error(
                error_message=error_msg,
                execution_time=time.time() - start_time,
                **kwargs,
            )
            await self._emit_tool_status("failed", error_msg)
            return result

    async def _ensure_playwright_in_sandbox(
        self, sandbox: Any
    ) -> tuple[bool, Optional[str]]:
        """Ensure Playwright is installed in the sandbox.

        Args:
            sandbox: E2B sandbox instance

        Returns:
            Tuple of (success, error_message or None)
        """
        try:
            # Check if Playwright is installed (Node.js version)
            check_result = await sandbox.commands.run(
                cmd="node -e \"require('playwright')\" 2>/dev/null && echo 'ok'",
                timeout=30,
            )

            if check_result.exit_code == 0 and "ok" in (check_result.stdout or ""):
                logger.info("[BaseBrowserTool] Playwright already installed in sandbox")
                return True, None

            # Install Playwright
            logger.info("[BaseBrowserTool] Installing Playwright in sandbox...")
            install_result = await sandbox.commands.run(
                cmd="npm install playwright && npx playwright install chromium --with-deps",
                timeout=600,  # 10 minutes for installation
            )

            if install_result.exit_code != 0:
                error = f"Failed to install Playwright: {install_result.stderr}"
                logger.error(f"[BaseBrowserTool] {error}")
                return False, error

            logger.info("[BaseBrowserTool] Playwright installed successfully")
            return True, None

        except Exception as e:
            error = f"Error ensuring Playwright: {str(e)}"
            logger.error(f"[BaseBrowserTool] {error}", exc_info=True)
            return False, error

    async def _run_browser_script(
        self,
        sandbox: Any,
        script_name: str,
        args: dict[str, Any],
        timeout: int = 60,
    ) -> tuple[bool, str, Optional[str]]:
        """Run a browser script in the sandbox.

        The browser skill scripts are synced to sandbox at $SKILL_BASE_PATH/browser/scripts/
        This method executes the JS script via Node.js.

        Args:
            sandbox: E2B sandbox instance
            script_name: Name of the script (without .js extension)
            args: Arguments to pass to the script as JSON
            timeout: Execution timeout in seconds

        Returns:
            Tuple of (success, stdout, error_message or None)
        """
        try:
            # Encode arguments as base64 to avoid shell escaping issues
            args_json = json.dumps(args, ensure_ascii=False)
            args_b64 = base64.b64encode(args_json.encode()).decode()

            # Build command to execute the script
            # SKILL_BASE_PATH environment variable contains the skills root directory
            cmd = f"node $SKILL_BASE_PATH/browser/scripts/{script_name}.js '{args_b64}'"

            result = await sandbox.commands.run(
                cmd=cmd,
                timeout=timeout,
            )

            if result.exit_code != 0:
                return False, result.stdout or "", result.stderr or "Unknown error"

            return True, result.stdout or "", None

        except Exception as e:
            error = f"Browser script execution failed: {str(e)}"
            logger.error(f"[BaseBrowserTool] {error}", exc_info=True)
            return False, "", error

    def _format_error(self, error_message: str, **kwargs) -> str:
        """Format error response as JSON string.

        Args:
            error_message: Error description
            **kwargs: Additional fields to include in response

        Returns:
            JSON string with error information
        """
        response = {
            "success": False,
            "error": error_message,
        }

        # Add any additional fields provided (filter out None values)
        response.update({k: v for k, v in kwargs.items() if v is not None})

        # Add suggestion if not provided
        if "suggestion" not in response:
            response["suggestion"] = (
                "The browser operation could not be completed. "
                "Please check the error message and try again."
            )

        return json.dumps(response, ensure_ascii=False, indent=2)

    async def _emit_tool_status(
        self,
        status: str,
        message: str = "",
        result: Optional[dict[str, Any]] = None,
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
