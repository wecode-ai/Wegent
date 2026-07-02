# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Interactive form tool-name matching helpers."""

from __future__ import annotations

import re

INTERACTIVE_FORM_TOOL_TYPE = "interactive_form_question"

_INTERACTIVE_FORM_TOOL_MARKERS = (
    INTERACTIVE_FORM_TOOL_TYPE,
    "ask_user_question",
    "request_user_input",
)

_INTERACTIVE_FORM_TOOL_COMPACT_MARKERS = (
    "interactiveformquestion",
    "askuserquestion",
    "requestuserinput",
)


def is_interactive_form_tool_name(tool_name: str | None) -> bool:
    """Return whether a tool name refers to an interactive form request."""
    normalized = (tool_name or "").strip().lower()
    if not normalized:
        return False

    if any(marker in normalized for marker in _INTERACTIVE_FORM_TOOL_MARKERS):
        return True

    compact = re.sub(r"[^a-z0-9]+", "", normalized)
    return any(marker in compact for marker in _INTERACTIVE_FORM_TOOL_COMPACT_MARKERS)
