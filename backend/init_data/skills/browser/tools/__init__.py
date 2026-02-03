# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser automation tools for sandbox execution.

This package contains tool definitions that are sent to the LLM.
Each tool executes its corresponding JS script in the sandbox.

Tools:
- BrowserNavigateTool: Navigate to URLs, go back/forward, reload
- BrowserClickTool: Click on page elements
- BrowserFillTool: Fill text into input fields
- BrowserScreenshotTool: Capture screenshots
"""

from .click import BrowserClickTool
from .fill import BrowserFillTool
from .navigate import BrowserNavigateTool
from .screenshot import BrowserScreenshotTool

__all__ = [
    "BrowserNavigateTool",
    "BrowserClickTool",
    "BrowserFillTool",
    "BrowserScreenshotTool",
]
