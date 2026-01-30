# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser screenshot tool using Playwright.

This module provides the BrowserScreenshotTool class that captures
screenshots of web pages or specific elements.
"""

import json
import logging
import os
import time
from typing import Literal, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class BrowserScreenshotInput(BaseModel):
    """Input schema for browser_screenshot tool."""

    file_path: str = Field(
        ...,
        description="Path to save the screenshot file",
    )
    selector: Optional[str] = Field(
        default=None,
        description="CSS selector for specific element (if not provided, captures full viewport)",
    )
    full_page: bool = Field(
        default=False,
        description="Capture entire scrollable page (default: false)",
    )
    type: Literal["png", "jpeg"] = Field(
        default="png",
        description="Image format: 'png' (default) or 'jpeg'",
    )
    quality: Optional[int] = Field(
        default=None,
        description="JPEG quality 0-100 (only for jpeg format)",
    )


# Import base class here - use try/except to handle both direct and dynamic loading
try:
    # Try relative import (for direct usage)
    from ._base import SCREENSHOT_MAX_SIZE, BaseBrowserTool
except ImportError:
    # Try absolute import (for dynamic loading as skill_pkg_browser)
    import sys

    # Get the package name dynamically
    package_name = __name__.rsplit(".", 1)[0]  # e.g., 'skill_pkg_browser'
    _base_module = sys.modules.get(f"{package_name}._base")
    if _base_module:
        BaseBrowserTool = _base_module.BaseBrowserTool
        SCREENSHOT_MAX_SIZE = _base_module.SCREENSHOT_MAX_SIZE
    else:
        raise ImportError(f"Cannot import _base from {package_name}")


class BrowserScreenshotTool(BaseBrowserTool):
    """Tool for capturing screenshots of web pages using Playwright.

    This tool provides screenshot capture capabilities with support for:
    - Full page screenshots
    - Element-specific screenshots
    - PNG and JPEG formats
    - Quality control for JPEG
    """

    name: str = "browser_screenshot"
    display_name: str = "Screenshot"
    description: str = """Take a screenshot of the current page or a specific element.

Use this tool to capture visual snapshots of web pages.

Parameters:
- file_path (required): Path to save the screenshot file
- selector (optional): CSS selector for specific element (if not provided, captures full viewport)
- full_page (optional): Capture entire scrollable page (default: false)
- type (optional): Image format - 'png' (default) or 'jpeg'
- quality (optional): JPEG quality 0-100 (only for jpeg format)

Returns:
- success: Whether screenshot was captured
- file_path: Path where screenshot was saved
- width: Image width in pixels
- height: Image height in pixels
- file_size: File size in bytes

Example:
{
  "file_path": "/home/user/screenshot.png",
  "full_page": true
}"""

    args_schema: type[BaseModel] = BrowserScreenshotInput

    # Configuration
    max_file_size: int = SCREENSHOT_MAX_SIZE  # 10MB default

    def _run(
        self,
        file_path: str,
        selector: Optional[str] = None,
        full_page: bool = False,
        type: str = "png",
        quality: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("BrowserScreenshotTool only supports async execution")

    async def _arun(
        self,
        file_path: str,
        selector: Optional[str] = None,
        full_page: bool = False,
        type: str = "png",
        quality: Optional[int] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Take a screenshot of the page or element.

        Args:
            file_path: Path to save the screenshot
            selector: CSS selector for specific element
            full_page: Capture entire scrollable page
            type: Image format (png, jpeg)
            quality: JPEG quality (0-100)
            run_manager: Callback manager

        Returns:
            JSON string with screenshot result
        """
        start_time = time.time()

        logger.info(
            f"[BrowserScreenshotTool] Taking screenshot: file_path={file_path}, "
            f"selector={selector}, full_page={full_page}, type={type}, quality={quality}"
        )

        # Emit status update via WebSocket if available
        await self._emit_tool_status(
            "running",
            f"Taking screenshot: {file_path}...",
        )

        try:
            # Get browser session manager
            browser_manager = self._get_browser_session_manager()

            # Get or create page
            page, error = await browser_manager.get_page()

            if error:
                logger.error(f"[BrowserScreenshotTool] Failed to get page: {error}")
                result = self._format_error(
                    error_message=f"Failed to get browser page: {error}",
                    execution_time=time.time() - start_time,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Ensure parent directory exists
            parent_dir = os.path.dirname(file_path)
            if parent_dir:
                os.makedirs(parent_dir, exist_ok=True)

            # Prepare screenshot options
            screenshot_options = {
                "path": file_path,
                "type": type,
                "full_page": full_page,
            }

            if type == "jpeg" and quality is not None:
                screenshot_options["quality"] = max(0, min(100, quality))

            # Take screenshot
            if selector:
                # Screenshot specific element
                element = page.locator(selector)
                await element.wait_for(timeout=self.default_timeout)
                screenshot_bytes = await element.screenshot(**screenshot_options)
            else:
                # Screenshot page
                screenshot_bytes = await page.screenshot(**screenshot_options)

            execution_time = time.time() - start_time

            # Get file size and dimensions
            file_size = os.path.getsize(file_path)

            # Check file size limit
            if file_size > self.max_file_size:
                os.remove(file_path)
                return self._format_error(
                    error_message=f"Screenshot file size ({file_size} bytes) exceeds limit ({self.max_file_size} bytes)",
                    file_path=file_path,
                    execution_time=execution_time,
                    suggestion=(
                        "The screenshot is too large. Try:\n"
                        "1. Use viewport-only screenshot (disable full_page)\n"
                        "2. Use JPEG format with lower quality\n"
                        "3. Screenshot a specific element instead of the full page"
                    ),
                )

            # Try to get image dimensions using PIL if available
            width, height = None, None
            try:
                from PIL import Image

                with Image.open(file_path) as img:
                    width, height = img.size
            except ImportError:
                logger.debug(
                    "[BrowserScreenshotTool] PIL not available for dimension detection"
                )
            except Exception as e:
                logger.debug(
                    f"[BrowserScreenshotTool] Could not get image dimensions: {e}"
                )

            result_data = {
                "success": True,
                "file_path": file_path,
                "file_size": file_size,
                "type": type,
                "full_page": full_page,
                "execution_time": execution_time,
            }

            if width and height:
                result_data["width"] = width
                result_data["height"] = height

            if selector:
                result_data["selector"] = selector

            logger.info(
                f"[BrowserScreenshotTool] Screenshot completed: file_path={file_path}, "
                f"size={file_size} bytes, time={execution_time:.2f}s"
            )

            await self._emit_tool_status(
                "completed", "Screenshot captured", result_data
            )
            return json.dumps(result_data, ensure_ascii=False, indent=2)

        except Exception as e:
            logger.error(
                f"[BrowserScreenshotTool] Screenshot failed: {e}", exc_info=True
            )
            error_msg = f"Screenshot failed: {e}"
            result = self._format_error(
                error_message=error_msg,
                file_path=file_path,
                selector=selector,
                execution_time=time.time() - start_time,
                suggestion=(
                    "The screenshot could not be captured. Please check:\n"
                    "1. The page has finished loading\n"
                    "2. The file path is writable\n"
                    "3. If using selector, ensure the element exists\n"
                    "4. Try navigating to a page first if no page is open"
                ),
            )
            await self._emit_tool_status("failed", error_msg)
            return result
