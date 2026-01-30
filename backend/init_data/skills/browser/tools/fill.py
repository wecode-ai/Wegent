# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser fill tool definition.

This module defines the BrowserFillTool for filling text into input fields.
The actual execution happens in sandbox via scripts/fill.js.
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


class BrowserFillTool(BaseBrowserTool):
    """Tool for filling text into input fields.

    This tool provides form filling capabilities with support for:
    - CSS selectors
    - XPath expressions
    - Clearing existing content before filling

    Execution happens in an isolated sandbox container.
    """

    name: str = "browser_fill"
    display_name: str = "Fill Input"
    description: str = """Fill text into an input field on the page.

Use this tool to fill form fields, search boxes, or any text input.
The browser runs in an isolated sandbox environment.

Parameters:
- selector (required): CSS selector or XPath for the input element
- value (required): Text content to fill
- selector_type (optional): Selector type - 'css' (default) or 'xpath'
- clear_first (optional): Clear existing content before filling (default: true)
- timeout_seconds (optional): Element wait timeout in seconds (default: 10)

Returns:
- success: Whether fill operation succeeded
- value_length: Length of filled text

Example:
{
  "selector": "#username",
  "value": "testuser"
}"""

    args_schema: type[BaseModel] = BrowserFillInput
    script_name: str = "fill"
    default_timeout: int = 10
