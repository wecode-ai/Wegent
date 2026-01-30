# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser click tool using Playwright.

This module provides the BrowserClickTool class that clicks
on page elements using CSS selectors, XPath, or text content.
"""

import json
import logging
import time
from typing import Literal, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class BrowserClickInput(BaseModel):
    """Input schema for browser_click tool."""

    selector: str = Field(
        ...,
        description="CSS selector, XPath expression, or text content to match the element",
    )
    selector_type: Literal["css", "xpath", "text"] = Field(
        default="css",
        description="Selector type: 'css' (default), 'xpath', or 'text'",
    )
    timeout_seconds: Optional[int] = Field(
        default=None,
        description="Element wait timeout in seconds (default: 10)",
    )
    force: bool = Field(
        default=False,
        description="Force click even if element is not visible (default: false)",
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


class BrowserClickTool(BaseBrowserTool):
    """Tool for clicking elements on web pages using Playwright.

    This tool provides element clicking capabilities with support for:
    - CSS selectors
    - XPath expressions
    - Text content matching
    """

    name: str = "browser_click"
    display_name: str = "Click Element"
    description: str = """Click on a page element using a selector.

Use this tool to click buttons, links, or any clickable elements.

Parameters:
- selector (required): CSS selector, XPath expression, or text to match
- selector_type (optional): Selector type - 'css' (default), 'xpath', 'text'
- timeout_seconds (optional): Element wait timeout in seconds (default: 10)
- force (optional): Force click even if element is not visible (default: false)

Returns:
- success: Whether click succeeded
- element_info: Information about the clicked element

Example:
{
  "selector": "button.submit-btn",
  "selector_type": "css"
}"""

    args_schema: type[BaseModel] = BrowserClickInput

    # Configuration
    element_timeout: int = 10  # seconds

    def _run(
        self,
        selector: str,
        selector_type: str = "css",
        timeout_seconds: Optional[int] = None,
        force: bool = False,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("BrowserClickTool only supports async execution")

    async def _arun(
        self,
        selector: str,
        selector_type: str = "css",
        timeout_seconds: Optional[int] = None,
        force: bool = False,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Click on a page element.

        Args:
            selector: CSS selector, XPath expression, or text to match
            selector_type: Type of selector (css, xpath, text)
            timeout_seconds: Element wait timeout in seconds
            force: Force click even if element is not visible
            run_manager: Callback manager

        Returns:
            JSON string with click result
        """
        start_time = time.time()
        effective_timeout = (
            timeout_seconds or self.element_timeout
        ) * 1000  # Convert to ms

        logger.info(
            f"[BrowserClickTool] Clicking: selector={selector}, type={selector_type}, "
            f"timeout={effective_timeout}ms, force={force}"
        )

        # Emit status update via WebSocket if available
        await self._emit_tool_status(
            "running",
            f"Clicking element: {selector[:50]}...",
        )

        try:
            # Get browser session manager
            browser_manager = self._get_browser_session_manager()

            # Get or create page
            page, error = await browser_manager.get_page()

            if error:
                logger.error(f"[BrowserClickTool] Failed to get page: {error}")
                result = self._format_error(
                    error_message=f"Failed to get browser page: {error}",
                    execution_time=time.time() - start_time,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Find and click element based on selector type
            element = None
            if selector_type == "css":
                element = page.locator(selector)
            elif selector_type == "xpath":
                element = page.locator(f"xpath={selector}")
            elif selector_type == "text":
                element = page.get_by_text(selector)
            else:
                return self._format_error(
                    error_message=f"Invalid selector_type: {selector_type}. Use 'css', 'xpath', or 'text'.",
                    execution_time=time.time() - start_time,
                )

            # Wait for element and click
            await element.wait_for(timeout=effective_timeout)
            await element.click(force=force, timeout=effective_timeout)

            execution_time = time.time() - start_time

            # Try to get element info
            element_info = {}
            try:
                element_info = {
                    "tag_name": await element.evaluate(
                        "el => el.tagName.toLowerCase()"
                    ),
                    "text_content": (await element.text_content() or "")[:100],
                }
                # Try to get more attributes
                element_info["class"] = await element.get_attribute("class") or ""
                element_info["id"] = await element.get_attribute("id") or ""
            except Exception as e:
                logger.debug(f"[BrowserClickTool] Could not get element info: {e}")

            result_data = {
                "success": True,
                "selector": selector,
                "selector_type": selector_type,
                "element_info": element_info,
                "execution_time": execution_time,
            }

            logger.info(
                f"[BrowserClickTool] Click completed: selector={selector}, "
                f"time={execution_time:.2f}s"
            )

            await self._emit_tool_status("completed", "Click successful", result_data)
            return json.dumps(result_data, ensure_ascii=False, indent=2)

        except Exception as e:
            logger.error(f"[BrowserClickTool] Click failed: {e}", exc_info=True)
            error_msg = f"Click failed: {e}"
            result = self._format_error(
                error_message=error_msg,
                selector=selector,
                selector_type=selector_type,
                execution_time=time.time() - start_time,
                suggestion=(
                    "The element could not be clicked. Please check:\n"
                    "1. The selector is correct\n"
                    "2. The element exists on the page\n"
                    "3. The element is visible and clickable\n"
                    "4. Try using 'force: true' if the element is hidden"
                ),
            )
            await self._emit_tool_status("failed", error_msg)
            return result
