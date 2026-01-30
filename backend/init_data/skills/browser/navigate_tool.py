# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser navigation tool using Playwright.

This module provides the BrowserNavigateTool class that navigates
to URLs and performs navigation actions (back, forward, reload).
"""

import json
import logging
import time
from typing import Literal, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class BrowserNavigateInput(BaseModel):
    """Input schema for browser_navigate tool."""

    url: str = Field(
        ...,
        description="The URL to navigate to. Required for 'goto' action.",
    )
    action: Literal["goto", "back", "forward", "reload"] = Field(
        default="goto",
        description="Navigation action: 'goto' (default), 'back', 'forward', or 'reload'",
    )
    wait_until: Literal["load", "domcontentloaded", "networkidle"] = Field(
        default="networkidle",
        description="Wait until condition: 'load', 'domcontentloaded', or 'networkidle' (default)",
    )
    timeout_seconds: Optional[int] = Field(
        default=None,
        description="Navigation timeout in seconds (default: 30)",
    )


# Import base class here - use try/except to handle both direct and dynamic loading
try:
    # Try relative import (for direct usage)
    from ._base import BaseBrowserTool
except ImportError:
    # Try absolute import (for dynamic loading as skill_pkg_browser)
    import sys

    # Get the package name dynamically
    package_name = __name__.rsplit(".", 1)[0]  # e.g., 'skill_pkg_browser'
    _base_module = sys.modules.get(f"{package_name}._base")
    if _base_module:
        BaseBrowserTool = _base_module.BaseBrowserTool
    else:
        raise ImportError(f"Cannot import _base from {package_name}")


class BrowserNavigateTool(BaseBrowserTool):
    """Tool for navigating browser pages using Playwright.

    This tool provides page navigation capabilities including:
    - Opening URLs
    - Going back/forward in history
    - Refreshing pages
    """

    name: str = "browser_navigate"
    display_name: str = "Navigate Page"
    description: str = """Navigate to a URL or perform navigation actions in the browser.

Use this tool to open web pages or navigate browser history.

Parameters:
- url (required): The URL to navigate to
- action (optional): Navigation action - 'goto' (default), 'back', 'forward', 'reload'
- wait_until (optional): Wait condition - 'load', 'domcontentloaded', 'networkidle' (default)
- timeout_seconds (optional): Navigation timeout in seconds (default: 30)

Returns:
- success: Whether navigation succeeded
- url: Current page URL after navigation
- title: Page title
- status: Page load status

Example:
{
  "url": "https://example.com",
  "wait_until": "networkidle"
}"""

    args_schema: type[BaseModel] = BrowserNavigateInput

    # Configuration
    navigation_timeout: int = 30  # seconds

    def _run(
        self,
        url: str,
        action: str = "goto",
        wait_until: str = "networkidle",
        timeout_seconds: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("BrowserNavigateTool only supports async execution")

    async def _arun(
        self,
        url: str,
        action: str = "goto",
        wait_until: str = "networkidle",
        timeout_seconds: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Navigate to URL or perform navigation action.

        Args:
            url: Target URL to navigate to
            action: Navigation action (goto, back, forward, reload)
            wait_until: Wait condition for page load
            timeout_seconds: Navigation timeout in seconds
            run_manager: Callback manager

        Returns:
            JSON string with navigation result
        """
        start_time = time.time()
        effective_timeout = (
            timeout_seconds or self.navigation_timeout
        ) * 1000  # Convert to ms

        logger.info(
            f"[BrowserNavigateTool] Navigating: action={action}, url={url[:100]}, "
            f"wait_until={wait_until}, timeout={effective_timeout}ms"
        )

        # Emit status update via WebSocket if available
        await self._emit_tool_status(
            "running",
            (
                f"Navigating to {url[:50]}..."
                if action == "goto"
                else f"Performing {action}..."
            ),
        )

        try:
            # Get browser session manager
            browser_manager = self._get_browser_session_manager()

            # Get or create page
            page, error = await browser_manager.get_page()

            if error:
                logger.error(f"[BrowserNavigateTool] Failed to get page: {error}")
                result = self._format_error(
                    error_message=f"Failed to get browser page: {error}",
                    execution_time=time.time() - start_time,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Perform navigation action
            response = None
            if action == "goto":
                if not url:
                    return self._format_error(
                        error_message="URL is required for 'goto' action",
                        execution_time=time.time() - start_time,
                    )
                response = await page.goto(
                    url,
                    wait_until=wait_until,
                    timeout=effective_timeout,
                )
            elif action == "back":
                response = await page.go_back(
                    wait_until=wait_until,
                    timeout=effective_timeout,
                )
            elif action == "forward":
                response = await page.go_forward(
                    wait_until=wait_until,
                    timeout=effective_timeout,
                )
            elif action == "reload":
                response = await page.reload(
                    wait_until=wait_until,
                    timeout=effective_timeout,
                )

            execution_time = time.time() - start_time

            # Get current page info
            current_url = page.url
            title = await page.title()

            result_data = {
                "success": True,
                "url": current_url,
                "title": title,
                "action": action,
                "status": response.status if response else None,
                "execution_time": execution_time,
            }

            logger.info(
                f"[BrowserNavigateTool] Navigation completed: url={current_url}, "
                f"title={title}, time={execution_time:.2f}s"
            )

            await self._emit_tool_status(
                "completed", "Navigation successful", result_data
            )
            return json.dumps(result_data, ensure_ascii=False, indent=2)

        except Exception as e:
            logger.error(f"[BrowserNavigateTool] Navigation failed: {e}", exc_info=True)
            error_msg = f"Navigation failed: {e}"
            result = self._format_error(
                error_message=error_msg,
                action=action,
                url=url,
                execution_time=time.time() - start_time,
            )
            await self._emit_tool_status("failed", error_msg)
            return result
