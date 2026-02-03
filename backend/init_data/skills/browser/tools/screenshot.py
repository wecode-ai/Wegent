# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser screenshot tool definition.

This module defines the BrowserScreenshotTool for capturing screenshots
of web pages or specific elements.
The actual execution happens in sandbox via scripts/screenshot.js.
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field

# Import base class - handle both direct and dynamic loading
try:
    from ._base import BaseBrowserTool
except ImportError:
    import sys

    package_name = __name__.rsplit(".", 1)[0]
    _base_module = sys.modules.get(f"{package_name}._base")
    if _base_module:
        BaseBrowserTool = _base_module.BaseBrowserTool
    else:
        raise ImportError(f"Cannot import _base from {package_name}")


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


class BrowserScreenshotTool(BaseBrowserTool):
    """Tool for capturing screenshots of web pages.

    This tool provides screenshot capture capabilities with support for:
    - Full page screenshots
    - Element-specific screenshots
    - PNG and JPEG formats
    - Quality control for JPEG

    Execution happens in an isolated sandbox container.
    """

    name: str = "browser_screenshot"
    display_name: str = "Screenshot"
    description: str = """Take a screenshot of the current page or a specific element.

Use this tool to capture visual snapshots of web pages.
The browser runs in an isolated sandbox environment.

Parameters:
- file_path (required): Path to save the screenshot file
- selector (optional): CSS selector for specific element (if not provided, captures full viewport)
- full_page (optional): Capture entire scrollable page (default: false)
- type (optional): Image format - 'png' (default) or 'jpeg'
- quality (optional): JPEG quality 0-100 (only for jpeg format)

Returns:
- success: Whether screenshot was captured
- file_path: Path where screenshot was saved
- file_size: File size in bytes

Example:
{
  "file_path": "/home/user/screenshot.png",
  "full_page": true
}"""

    args_schema: type[BaseModel] = BrowserScreenshotInput
    script_name: str = "screenshot"
    default_timeout: int = 30
