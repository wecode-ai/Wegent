# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo Tools skill provider.

This module provides the WeiboToolProvider class that creates tools for
the three-phase lazy loading approach to Weibo MCP services:

Phase 1: list_weibo_mcps
    - Returns static catalog of available MCP servers
    - NO network connection required
    - Minimal token usage

Phase 2: load_weibo_mcp_tools
    - Connects to a SPECIFIC MCP server
    - Returns tools from that server only
    - Moderate token usage

Phase 3: invoke_weibo_tool
    - Calls a specific tool from a loaded server
    - Returns tool execution result

Supported Weibo MCP Services:
- weibo-status: Query weibo content by ID or user
- weibo-user: Get user profile information
- weibo-comments: Query comments data
- weibo-search: Get hot search list and topics
- wegent-fetch: Fetch weibo content by URL
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider


class WeiboToolProvider(SkillToolProvider):
    """Tool provider for Weibo MCP tools with three-phase lazy loading.

    This provider creates three tools that work together:
    1. list_weibo_mcps - Phase 1: Discover available MCP servers
    2. load_weibo_mcp_tools - Phase 2: Load tools from a specific server
    3. invoke_weibo_tool - Phase 3: Call a specific tool

    The provider maintains a shared state manager to track loaded servers
    and tools across all three phases within a session.

    Example SKILL.md configuration:
        tools:
          - name: list_weibo_mcps
            provider: weibo-tools
          - name: load_weibo_mcp_tools
            provider: weibo-tools
            config:
              timeout: 60
          - name: invoke_weibo_tool
            provider: weibo-tools
    """

    # Shared state manager for the session
    _state_manager: Optional[Any] = None

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
            List containing all three phase tools
        """
        return ["list_weibo_mcps", "load_weibo_mcp_tools", "invoke_weibo_tool"]

    def _get_state_manager(self) -> Any:
        """Get or create the shared state manager."""
        if self._state_manager is None:
            from .load_weibo_tools import WeiboToolsStateManager

            self._state_manager = WeiboToolsStateManager()
        return self._state_manager

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a Weibo tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies (task_id, subtask_id, etc.)
            tool_config: Optional configuration with keys:
                - timeout: Connection timeout in seconds (default: 60)

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is unknown
        """
        timeout = 60.0
        if tool_config and "timeout" in tool_config:
            timeout = float(tool_config["timeout"])

        # Get shared state manager
        state_manager = self._get_state_manager()

        if tool_name == "list_weibo_mcps":
            from .load_weibo_tools import ListWeiboMCPsTool

            return ListWeiboMCPsTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                user_id=context.user_id,
            )

        elif tool_name == "load_weibo_mcp_tools":
            from .load_weibo_tools import LoadWeiboMCPToolsTool

            tool = LoadWeiboMCPToolsTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                user_id=context.user_id,
                timeout=timeout,
            )
            tool.set_state_manager(state_manager)
            return tool

        elif tool_name == "invoke_weibo_tool":
            from .load_weibo_tools import InvokeWeiboToolTool

            tool = InvokeWeiboToolTool()
            tool.set_state_manager(state_manager)
            return tool

        raise ValueError(f"Unknown tool: {tool_name}")

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate Weibo tool configuration.

        Args:
            tool_config: Configuration to validate

        Returns:
            True if valid, False otherwise
        """
        if not tool_config:
            return True

        timeout = tool_config.get("timeout")
        if timeout is not None:
            if not isinstance(timeout, (int, float)):
                return False
            if timeout <= 0:
                return False

        return True
