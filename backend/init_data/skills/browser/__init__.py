# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser automation skill package using Playwright."""

# Import base module first to ensure common utilities are available
from . import _base

__all__ = [
    "_base",
    "navigate_tool",
    "click_tool",
    "fill_tool",
    "screenshot_tool",
    "provider",
]
