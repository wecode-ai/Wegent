# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser form fill tool using Playwright.

This module provides the BrowserFillTool class that fills
text into input fields on web pages.
"""

import json
import logging
import time
from typing import Literal, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class BrowserFillInput(BaseModel):
    """Input schema for browser_fill tool."""

    selector: str = Field(
        ...,
        description="CSS selector or XPath expression for the input element",
    )
    value: str = Field(
        ...,
        description="Text content to fill into the input",
    )
    selector_type: Literal["css", "xpath"] = Field(
        default="css",
        description="Selector type: 'css' (default) or 'xpath'",
    )
    clear_first: bool = Field(
        default=True,
        description="Clear existing content before filling (default: true)",
    )
    timeout_seconds: Optional[int] = Field(
        default=None,
        description="Element wait timeout in seconds (default: 10)",
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


class BrowserFillTool(BaseBrowserTool):
    """Tool for filling text into input fields using Playwright.

    This tool provides form filling capabilities with support for:
    - CSS selectors
    - XPath expressions
    - Clearing existing content before filling
    """

    name: str = "browser_fill"
    display_name: str = "Fill Input"
    description: str = """Fill text into an input field on the page.

Use this tool to fill form fields, search boxes, or any text input.

Parameters:
- selector (required): CSS selector or XPath for the input element
- value (required): Text content to fill
- selector_type (optional): Selector type - 'css' (default) or 'xpath'
- clear_first (optional): Clear existing content before filling (default: true)
- timeout_seconds (optional): Element wait timeout in seconds (default: 10)

Returns:
- success: Whether fill operation succeeded

Example:
{
  "selector": "#username",
  "value": "testuser"
}"""

    args_schema: type[BaseModel] = BrowserFillInput

    # Configuration
    element_timeout: int = 10  # seconds

    def _run(
        self,
        selector: str,
        value: str,
        selector_type: str = "css",
        clear_first: bool = True,
        timeout_seconds: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("BrowserFillTool only supports async execution")

    async def _arun(
        self,
        selector: str,
        value: str,
        selector_type: str = "css",
        clear_first: bool = True,
        timeout_seconds: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Fill text into an input field.

        Args:
            selector: CSS selector or XPath for the input element
            value: Text content to fill
            selector_type: Type of selector (css, xpath)
            clear_first: Clear existing content before filling
            timeout_seconds: Element wait timeout in seconds
            run_manager: Callback manager

        Returns:
            JSON string with fill result
        """
        start_time = time.time()
        effective_timeout = (
            timeout_seconds or self.element_timeout
        ) * 1000  # Convert to ms

        # Truncate value for logging
        log_value = value[:50] + "..." if len(value) > 50 else value

        logger.info(
            f"[BrowserFillTool] Filling: selector={selector}, value={log_value}, "
            f"type={selector_type}, clear_first={clear_first}, timeout={effective_timeout}ms"
        )

        # Emit status update via WebSocket if available
        await self._emit_tool_status(
            "running",
            f"Filling input: {selector[:50]}...",
        )

        try:
            # Get browser session manager
            browser_manager = self._get_browser_session_manager()

            # Get or create page
            page, error = await browser_manager.get_page()

            if error:
                logger.error(f"[BrowserFillTool] Failed to get page: {error}")
                result = self._format_error(
                    error_message=f"Failed to get browser page: {error}",
                    execution_time=time.time() - start_time,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Find element based on selector type
            element = None
            if selector_type == "css":
                element = page.locator(selector)
            elif selector_type == "xpath":
                element = page.locator(f"xpath={selector}")
            else:
                return self._format_error(
                    error_message=f"Invalid selector_type: {selector_type}. Use 'css' or 'xpath'.",
                    execution_time=time.time() - start_time,
                )

            # Wait for element
            await element.wait_for(timeout=effective_timeout)

            # Clear first if requested
            if clear_first:
                await element.clear(timeout=effective_timeout)

            # Fill the value
            await element.fill(value, timeout=effective_timeout)

            execution_time = time.time() - start_time

            result_data = {
                "success": True,
                "selector": selector,
                "selector_type": selector_type,
                "value_length": len(value),
                "clear_first": clear_first,
                "execution_time": execution_time,
            }

            logger.info(
                f"[BrowserFillTool] Fill completed: selector={selector}, "
                f"value_length={len(value)}, time={execution_time:.2f}s"
            )

            await self._emit_tool_status("completed", "Fill successful", result_data)
            return json.dumps(result_data, ensure_ascii=False, indent=2)

        except Exception as e:
            logger.error(f"[BrowserFillTool] Fill failed: {e}", exc_info=True)
            error_msg = f"Fill failed: {e}"
            result = self._format_error(
                error_message=error_msg,
                selector=selector,
                selector_type=selector_type,
                execution_time=time.time() - start_time,
                suggestion=(
                    "The input could not be filled. Please check:\n"
                    "1. The selector is correct and points to an input element\n"
                    "2. The element exists and is visible on the page\n"
                    "3. The element is not disabled or read-only\n"
                    "4. Try increasing the timeout if the page is slow to load"
                ),
            )
            await self._emit_tool_status("failed", error_msg)
            return result
