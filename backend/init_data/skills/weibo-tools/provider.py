# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo Tools skill provider.

This module provides the WeiboToolProvider class that creates LoadWeiboToolsTool
and InvokeWeiboToolTool instances for dynamically loading and using Weibo MCP
server tools on demand.

The key design principle is "lazy loading" - Weibo MCP tools are only connected
and loaded when the LLM determines they are needed (e.g., when user asks about
Weibo content, hot search, user info, comments, etc.), avoiding the overhead
of sending all tool schemas to the LLM upfront.

Supported Weibo MCP Services:
- Weibo Status: Query weibo content by ID or user
- Weibo User: Get user profile information
- Weibo Comments: Query comments data
- Weibo Search: Get hot search list and topics
- Wegent Fetch: Fetch weibo content by URL
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider


class WeiboToolProvider(SkillToolProvider):
    """Tool provider for Weibo MCP tools.

    This provider creates LoadWeiboToolsTool and InvokeWeiboToolTool instances
    that enable on-demand loading and invocation of Weibo-related tools from
    configured MCP servers.

    The two tools work together:
    1. LoadWeiboToolsTool connects to Weibo MCP servers and discovers tools
    2. InvokeWeiboToolTool uses the loaded tools to execute operations

    Example SKILL.md configuration:
        tools:
          - name: load_weibo_tools
            provider: weibo-tools
            config:
              timeout: 60
          - name: invoke_weibo_tool
            provider: weibo-tools
            config:
              timeout: 60
    """

    # Shared LoadWeiboToolsTool instance per session
    # This ensures invoke_weibo_tool can access tools loaded by load_weibo_tools
    _load_tool_instance: Optional["BaseTool"] = None

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
            List containing "load_weibo_tools" and "invoke_weibo_tool"
        """
        return ["load_weibo_tools", "invoke_weibo_tool"]

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

        if tool_name == "load_weibo_tools":
            from .load_weibo_tools import LoadWeiboToolsTool

            # Create and cache the load tool instance
            self._load_tool_instance = LoadWeiboToolsTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                user_id=context.user_id,
                timeout=timeout,
            )
            return self._load_tool_instance

        elif tool_name == "invoke_weibo_tool":
            from .load_weibo_tools import InvokeWeiboToolTool, LoadWeiboToolsTool

            # If load_weibo_tools hasn't been created yet, create it first
            if self._load_tool_instance is None:
                self._load_tool_instance = LoadWeiboToolsTool(
                    task_id=context.task_id,
                    subtask_id=context.subtask_id,
                    user_id=context.user_id,
                    timeout=timeout,
                )

            return InvokeWeiboToolTool(
                load_weibo_tools_ref=self._load_tool_instance,
            )

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
