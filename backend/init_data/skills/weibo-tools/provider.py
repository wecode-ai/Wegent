# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo Tools skill provider.

This module provides the WeiboToolProvider class for the Weibo skill.

Note: This skill primarily uses MCP servers configured in SKILL.md to provide
tools for accessing Weibo platform data. The skill system automatically
connects to the MCP servers and loads their tools.

Supported Weibo MCP Services (configured in SKILL.md mcpServers):
- statusServer: Query weibo content by ID or user
- userServer: Get user profile information
- commentsServer: Query comments data
- searchServer: Get hot search list and topics
- fetchServer: Fetch weibo content by URL
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider


class WeiboToolProvider(SkillToolProvider):
    """Skill provider for Weibo Tools.

    This is a minimal provider class required by the skill system.
    The actual tools are provided by MCP servers configured in SKILL.md's
    mcpServers section. The skill system automatically handles:
    - Connecting to MCP servers
    - Loading tools from each server
    - Variable substitution (e.g., ${{user.name}})

    No custom tool implementations are needed since all functionality
    is provided by the MCP servers.
    """

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "weibo-tools"
        """
        return "weibo-tools"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        Returns:
            Empty list since all tools come from MCP servers
        """
        return []

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a tool instance.

        This method should not be called since this skill uses MCP servers
        instead of custom tools.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies
            tool_config: Optional configuration

        Raises:
            ValueError: Always, since tools come from MCP servers
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
            True (no custom configuration needed)
        """
        return True
