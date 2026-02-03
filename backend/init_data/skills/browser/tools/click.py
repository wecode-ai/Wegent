# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser click tool definition.

This module defines the BrowserClickTool for clicking on page elements
using CSS selectors, XPath, or text content.
The actual execution happens in sandbox via scripts/click.js.
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


class BrowserClickTool(BaseBrowserTool):
    """Tool for clicking elements on web pages.

    This tool provides element clicking capabilities with support for:
    - CSS selectors
    - XPath expressions
    - Text content matching

    Execution happens in an isolated sandbox container.
    """

    name: str = "browser_click"
    display_name: str = "Click Element"
    description: str = """Click on a page element using a selector.

Use this tool to click buttons, links, or any clickable elements.
The browser runs in an isolated sandbox environment.

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
    script_name: str = "click"
    default_timeout: int = 10
