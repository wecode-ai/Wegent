# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Silent Exit tool for subscription background tasks.

This tool allows AI to silently terminate execution without notifying the user
when the result does not require attention (e.g., normal status, no anomalies).
"""

from langchain_core.callbacks import (
    AsyncCallbackManagerForToolRun,
    CallbackManagerForToolRun,
)
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


class SilentExitInput(BaseModel):
    """Input schema for silent_exit tool."""

    reason: str = Field(
        default="",
        description="Optional reason for silent exit (for logging only, not shown to user)",
    )


class SilentExitException(Exception):
    """Exception raised when silent_exit tool is called to terminate execution.

    This exception is caught by the agent loop to immediately terminate
    the conversation without generating further content.
    """

    def __init__(self, reason: str = ""):
        self.reason = reason
        super().__init__(
            f"Silent exit requested: {reason}" if reason else "Silent exit requested"
        )


class SilentExitTool(BaseTool):
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

    name: str = "silent_exit"
    display_name: str = "静默退出"
    description: str = (
        "Call this tool when the execution result does not require user attention. "
        "For example: regular status checks with no anomalies, routine data collection "
        "with expected results, or monitoring tasks where everything is normal. "
        "This will end the conversation immediately without notifying the user, "
        "and the execution will be hidden from the timeline by default."
    )
    args_schema: type[BaseModel] = SilentExitInput

    def _run(
        self,
        reason: str = "",
        _run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute silent exit - raises SilentExitException to terminate.

        Args:
            reason: Optional reason for silent exit (logged but not shown to user).
            _run_manager: Optional callback manager (not used).

        Raises:
            SilentExitException: Always raised to terminate the agent loop.
        """
        raise SilentExitException(reason=reason)

    async def _arun(
        self,
        reason: str = "",
        _run_manager: AsyncCallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute silent exit asynchronously - raises SilentExitException.

        Args:
            reason: Optional reason for silent exit (logged but not shown to user).
            _run_manager: Optional callback manager (not used).

        Raises:
            SilentExitException: Always raised to terminate the agent loop.
        """
        raise SilentExitException(reason=reason)
