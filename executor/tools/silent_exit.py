# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Silent Exit tool for subscription background tasks.

This tool allows AI to silently terminate execution without notifying the user
when the result does not require attention (e.g., normal status, no anomalies).
"""

import json
from typing import Optional

from agno.tools import Toolkit

# Special marker to detect silent exit in tool results
SILENT_EXIT_MARKER = "__silent_exit__"


class SilentExitTool(Toolkit):
    """Tool to silently exit execution without notifying the user.

    Use this tool when the execution result does not require user attention.
    For example:
    - Regular status checks with no anomalies
    - Routine data collection with expected results
    - Monitoring tasks where everything is normal

    Calling this tool will immediately terminate the conversation and mark
    the execution as "COMPLETED_SILENT". Silent executions are hidden from
    the timeline by default (can be shown via a toggle).
    """

    def __init__(self) -> None:
        super().__init__(name="silent_exit_toolkit")
        self.register(self.silent_exit)

    def silent_exit(self, reason: Optional[str] = None) -> str:
        """Silently exit the execution without notifying the user.

        Call this when the execution result does not require user attention.
        For example: regular status checks with no anomalies, routine data collection
        with expected results, or monitoring tasks where everything is normal.

        Args:
            reason: Optional reason for silent exit (for logging only, not shown to user)

        Returns:
            A JSON marker indicating silent exit was requested
        """
        return json.dumps({SILENT_EXIT_MARKER: True, "reason": reason or ""})


def detect_silent_exit(result: str) -> tuple[bool, str]:
    """Check if a tool result contains the silent exit marker.

    Args:
        result: Tool result string to check

    Returns:
        Tuple of (is_silent_exit, reason)
    """
    try:
        data = json.loads(result)
        if isinstance(data, dict) and data.get(SILENT_EXIT_MARKER):
            return True, data.get("reason", "")
    except (json.JSONDecodeError, TypeError):
        pass
    return False, ""
