# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser navigation tool definition.

This module defines the BrowserNavigateTool for navigating to URLs
and performing navigation actions (back, forward, reload).
The actual execution happens in sandbox via scripts/navigate.js.
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


class BrowserNavigateTool(BaseBrowserTool):
    """Tool for navigating browser pages.

    This tool provides page navigation capabilities including:
    - Opening URLs
    - Going back/forward in history
    - Refreshing pages

    Execution happens in an isolated sandbox container.
    """

    name: str = "browser_navigate"
    display_name: str = "Navigate Page"
    description: str = """Navigate to a URL or perform navigation actions in the browser.

Use this tool to open web pages or navigate browser history.
The browser runs in an isolated sandbox environment.

Parameters:
- url (required): The URL to navigate to
- action (optional): Navigation action - 'goto' (default), 'back', 'forward', 'reload'
- wait_until (optional): Wait condition - 'load', 'domcontentloaded', 'networkidle' (default)
- timeout_seconds (optional): Navigation timeout in seconds (default: 30)

Returns:
- success: Whether navigation succeeded
- url: Current page URL after navigation
- title: Page title
- status: HTTP status code

Example:
{
  "url": "https://example.com",
  "wait_until": "networkidle"
}"""

    args_schema: type[BaseModel] = BrowserNavigateInput
    script_name: str = "navigate"
    default_timeout: int = 30
