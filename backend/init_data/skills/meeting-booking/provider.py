# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Meeting booking tool provider.

This module provides the MeetingBookingToolProvider class that creates
GetMeetingResourcesTool instances for skills that declare meeting-booking
tool dependencies.

This provider is dynamically loaded from the skill directory at runtime.
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from app.chat_shell.skills import SkillToolContext, SkillToolProvider


class MeetingBookingToolProvider(SkillToolProvider):
    """Tool provider for meeting booking functionality.

    This provider creates GetMeetingResourcesTool instances for skills
    that declare meeting-booking tool dependencies.

    Example SKILL.md configuration:
        tools:
          - name: get_meeting_resources
            provider: meeting-booking
            config:
              timeout: 30
    """

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "meeting-booking"
        """
        return "meeting-booking"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        Returns:
            List containing "get_meeting_resources"
        """
        return ["get_meeting_resources"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a meeting booking tool instance.

        Args:
            tool_name: Name of the tool to create (must be "get_meeting_resources")
            context: Context with dependencies (task_id, subtask_id, ws_emitter)
            tool_config: Optional configuration with keys:
                - timeout: API timeout in seconds (default: 30)

        Returns:
            Configured GetMeetingResourcesTool instance

        Raises:
            ValueError: If tool_name is not "get_meeting_resources"
        """
        if tool_name != "get_meeting_resources":
            raise ValueError(f"Unknown tool: {tool_name}")

        # Import from local module within this skill package
        from .get_meeting_resources import GetMeetingResourcesTool

        config = tool_config or {}

        return GetMeetingResourcesTool(
            task_id=context.task_id,
            subtask_id=context.subtask_id,
            ws_emitter=context.ws_emitter,
            api_timeout=config.get("timeout", 30),
        )

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate meeting booking tool configuration.

        Args:
            tool_config: Configuration to validate

        Returns:
            True if valid, False otherwise
        """
        if not tool_config:
            return True

        # Validate timeout if present
        timeout = tool_config.get("timeout")
        if timeout is not None:
            if not isinstance(timeout, (int, float)):
                return False
            if timeout <= 0:
                return False

        return True
