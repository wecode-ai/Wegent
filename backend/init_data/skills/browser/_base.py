# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base class and session manager for browser automation tools.

This module provides shared functionality for browser automation tools using Playwright:
- Browser session management (singleton per sandbox session)
- Base tool class with common dependencies
- Error handling and WebSocket status emission
"""

import asyncio
import json
import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Default configuration
DEFAULT_BROWSER_TIMEOUT = 30000  # 30 seconds in milliseconds
DEFAULT_ELEMENT_TIMEOUT = 10000  # 10 seconds in milliseconds
SCREENSHOT_MAX_SIZE = 10485760  # 10MB


class BrowserSessionManager:
    """Manager for Playwright browser sessions (Singleton per sandbox session).

    This class manages browser lifecycle within a sandbox session:
    - Browser creation and reuse
    - Page management
    - Automatic cleanup

    Browser instances are reused within the same sandbox session to maintain
    state (cookies, localStorage, etc.) across multiple tool calls.
    """

    # Class-level dictionary to store singleton instances per task_id
    _instances: dict[int, "BrowserSessionManager"] = {}
    _lock = asyncio.Lock()

    def __init__(
        self,
        task_id: int,
        headless: bool = True,
        default_timeout: int = DEFAULT_BROWSER_TIMEOUT,
    ):
        """Initialize browser session manager.

        Note: Don't call this directly, use get_instance() instead.

        Args:
            task_id: Task ID for session tracking
            headless: Run browser in headless mode (default: True)
            default_timeout: Default timeout in milliseconds (default: 30000)
        """
        self.task_id = task_id
        self.headless = headless
        self.default_timeout = default_timeout

        # Browser instances (created lazily)
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._initialized = False

    @classmethod
    def get_instance(
        cls,
        task_id: int,
        headless: bool = True,
        default_timeout: int = DEFAULT_BROWSER_TIMEOUT,
    ) -> "BrowserSessionManager":
        """Get or create a singleton BrowserSessionManager instance for the given task_id.

        Args:
            task_id: Task ID for session tracking
            headless: Run browser in headless mode (default: True)
            default_timeout: Default timeout in milliseconds (default: 30000)

        Returns:
            BrowserSessionManager instance for the task_id
        """
        if task_id not in cls._instances:
            logger.info(
                f"[BrowserSessionManager] Creating new instance for task_id={task_id}"
            )
            cls._instances[task_id] = cls(task_id, headless, default_timeout)
        else:
            logger.debug(
                f"[BrowserSessionManager] Reusing existing instance for task_id={task_id}"
            )
        return cls._instances[task_id]

    @classmethod
    def remove_instance(cls, task_id: int) -> None:
        """Remove the BrowserSessionManager instance for the given task_id.

        This should be called when the task is completed to clean up resources.

        Args:
            task_id: Task ID to remove
        """
        if task_id in cls._instances:
            logger.info(
                f"[BrowserSessionManager] Removing instance for task_id={task_id}"
            )
            instance = cls._instances[task_id]
            # Cleanup is async, but we'll schedule it
            asyncio.create_task(instance.close())
            del cls._instances[task_id]

    async def ensure_playwright_installed(self) -> tuple[bool, Optional[str]]:
        """Ensure Playwright and Chromium are installed.

        This method checks if Playwright is installed and installs it if necessary.
        It also installs the Chromium browser with dependencies.

        Returns:
            Tuple of (success, error_message or None)
        """
        try:
            # Try to import playwright first
            try:
                from playwright.async_api import async_playwright

                logger.info("[BrowserSessionManager] Playwright is already installed")
            except ImportError:
                logger.info(
                    "[BrowserSessionManager] Playwright not found, installing..."
                )
                # Install playwright using pip
                import subprocess

                result = subprocess.run(
                    ["pip", "install", "playwright"],
                    capture_output=True,
                    text=True,
                    timeout=300,
                )
                if result.returncode != 0:
                    return False, f"Failed to install playwright: {result.stderr}"

                # Install Chromium with dependencies
                logger.info(
                    "[BrowserSessionManager] Installing Chromium browser with dependencies..."
                )
                result = subprocess.run(
                    ["playwright", "install", "chromium", "--with-deps"],
                    capture_output=True,
                    text=True,
                    timeout=600,
                )
                if result.returncode != 0:
                    return (
                        False,
                        f"Failed to install Chromium: {result.stderr}",
                    )

                logger.info(
                    "[BrowserSessionManager] Playwright and Chromium installed successfully"
                )

            return True, None

        except Exception as e:
            logger.error(
                f"[BrowserSessionManager] Error ensuring Playwright installed: {e}",
                exc_info=True,
            )
            return False, str(e)

    async def get_page(self) -> tuple[Any, Optional[str]]:
        """Get or create a browser page.

        This method ensures Playwright is installed, creates a browser if needed,
        and returns a page for interaction.

        Returns:
            Tuple of (page instance, error_message or None)
        """
        try:
            # Ensure Playwright is installed
            if not self._initialized:
                success, error = await self.ensure_playwright_installed()
                if not success:
                    return None, error

            # Import playwright (should be available now)
            from playwright.async_api import async_playwright

            # Create playwright instance if needed
            if self._playwright is None:
                logger.info("[BrowserSessionManager] Starting Playwright...")
                self._playwright = await async_playwright().start()

            # Create browser if needed
            if self._browser is None:
                logger.info(
                    f"[BrowserSessionManager] Launching Chromium (headless={self.headless})..."
                )
                self._browser = await self._playwright.chromium.launch(
                    headless=self.headless,
                    args=[
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-gpu",
                    ],
                )

            # Create context if needed
            if self._context is None:
                logger.info("[BrowserSessionManager] Creating browser context...")
                self._context = await self._browser.new_context(
                    viewport={"width": 1920, "height": 1080},
                    user_agent=(
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    ),
                )
                self._context.set_default_timeout(self.default_timeout)

            # Create page if needed
            if self._page is None or self._page.is_closed():
                logger.info("[BrowserSessionManager] Creating new page...")
                self._page = await self._context.new_page()

            self._initialized = True
            return self._page, None

        except Exception as e:
            logger.error(
                f"[BrowserSessionManager] Error getting page: {e}", exc_info=True
            )
            return None, str(e)

    async def close(self) -> None:
        """Close browser and cleanup resources."""
        try:
            if self._page and not self._page.is_closed():
                await self._page.close()
            if self._context:
                await self._context.close()
            if self._browser:
                await self._browser.close()
            if self._playwright:
                await self._playwright.stop()

            self._page = None
            self._context = None
            self._browser = None
            self._playwright = None
            self._initialized = False

            logger.info(
                f"[BrowserSessionManager] Browser closed for task_id={self.task_id}"
            )
        except Exception as e:
            logger.warning(f"[BrowserSessionManager] Error closing browser: {e}")


# Import BaseTool for base class definition
try:
    from langchain_core.tools import BaseTool

    class BaseBrowserTool(BaseTool):
        """Base class for Browser automation tools with common dependencies and configuration.

        This base class provides common attributes and browser session management for all
        browser automation tools. Subclasses should override the specific tool methods
        (_run, _arun) to implement their functionality.

        Attributes:
            task_id: Task ID for session tracking
            subtask_id: Subtask ID for session tracking
            ws_emitter: WebSocket emitter for status updates
            user_id: User ID for session metadata
            user_name: Username for session metadata
            default_timeout: Default timeout in milliseconds
            headless: Run browser in headless mode
        """

        # Injected dependencies - set when creating the tool instance
        task_id: int = 0
        subtask_id: int = 0
        ws_emitter: Any = None
        user_id: int = 0
        user_name: str = ""

        # Configuration
        default_timeout: int = DEFAULT_BROWSER_TIMEOUT
        headless: bool = True

        class Config:
            arbitrary_types_allowed = True

        def _get_browser_session_manager(self) -> BrowserSessionManager:
            """Get or create browser session manager for this tool instance.

            Returns:
                BrowserSessionManager singleton instance for this task
            """
            return BrowserSessionManager.get_instance(
                task_id=self.task_id,
                headless=self.headless,
                default_timeout=self.default_timeout,
            )

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

            # Add any additional fields provided
            response.update(kwargs)

            # Add suggestion if not provided
            if "suggestion" not in response:
                response["suggestion"] = (
                    "The browser operation could not be completed. "
                    "Please check the error message and try again. "
                    "Ensure Playwright is installed: pip install playwright && playwright install chromium --with-deps"
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
        "[BaseBrowserTool] langchain_core not available, BaseBrowserTool not defined"
    )
    BaseBrowserTool = None
