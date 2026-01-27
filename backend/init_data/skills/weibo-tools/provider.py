# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo Tools skill provider.

This module provides the WeiboToolProvider class for the Weibo skill.

Note: This skill primarily uses MCP servers configured in SKILL.md to provide
tools for accessing Weibo platform data. The MCP servers include:

- statusServer: Query weibo content by ID or user
- commentsServer: Query comments data
- userServer: Get user profile information
- searchServer: Get hot search topics and related weibos
- fetchServer: Fetch weibo content by URL

The provider itself does not create custom tools since all functionality
is provided through the MCP servers. This is a placeholder provider that
allows the skill to be properly loaded by the system.
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider


class WeiboToolProvider(SkillToolProvider):
    """Tool provider for Weibo skill.

    This provider serves as a placeholder for the Weibo skill. All actual
    tools are provided by MCP servers configured in SKILL.md, not through
    this provider's create_tool method.

    The MCP servers provide comprehensive access to Weibo platform data:
    - Weibo content (posts) querying
    - User profile information
    - Comments data
    - Hot search topics
    - URL-based content fetching
    """

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "weibo_tools"
        """
        return "weibo_tools"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        This provider does not create custom tools - all tools come from
        MCP servers. Returns an empty list.

        Returns:
            Empty list (tools are provided by MCP servers)
        """
        return []

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a tool instance.

        This method is not used for the Weibo skill since all tools are
        provided by MCP servers configured in SKILL.md.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies (task_id, subtask_id, etc.)
            tool_config: Optional configuration

        Raises:
            ValueError: Always raises since no custom tools are supported
        """
        raise ValueError(
            f"Unknown tool: {tool_name}. "
            "Weibo skill tools are provided by MCP servers, not this provider."
        )

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate tool configuration.

        Args:
            tool_config: Configuration to validate

        Returns:
            True (no custom tools, so any config is valid)
        """
        return True
