# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP Tools skill provider.

This module provides the MCPToolProvider class that creates LoadMCPToolsTool
and InvokeMCPToolTool instances for dynamically loading and using MCP server
tools on demand.

The key design principle is "lazy loading" - MCP tools are only connected
and loaded when the LLM determines they are needed, avoiding the overhead
of sending all tool schemas to the LLM upfront.

Architecture:
- LoadMCPToolsTool: Connects to MCP servers and discovers available tools
- InvokeMCPToolTool: Proxy tool to call loaded MCP tools by name
- Both tools share state to enable the invoke tool to access loaded MCP tools
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider


class MCPToolProvider(SkillToolProvider):
    """Tool provider for MCP (Model Context Protocol) tools.

    This provider creates LoadMCPToolsTool and InvokeMCPToolTool instances
    that enable on-demand loading and invocation of tools from configured
    MCP servers.

    The two tools work together:
    1. LoadMCPToolsTool connects to MCP servers and discovers tools
    2. InvokeMCPToolTool uses the loaded tools to execute operations

    Example SKILL.md configuration:
        tools:
          - name: load_mcp_tools
            provider: mcp-tools
            config:
              timeout: 60
          - name: invoke_mcp_tool
            provider: mcp-tools
            config:
              timeout: 60
    """

    # Shared LoadMCPToolsTool instance per session
    # This ensures invoke_mcp_tool can access tools loaded by load_mcp_tools
    _load_tool_instance: Optional["BaseTool"] = None

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "mcp-tools"
        """
        return "mcp-tools"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        Returns:
            List containing "load_mcp_tools" and "invoke_mcp_tool"
        """
        return ["load_mcp_tools", "invoke_mcp_tool"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create an MCP tool instance.

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

        if tool_name == "load_mcp_tools":
            from .load_mcp_tools import LoadMCPToolsTool

            # Create and cache the load tool instance
            self._load_tool_instance = LoadMCPToolsTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                user_id=context.user_id,
                timeout=timeout,
            )
            return self._load_tool_instance

        elif tool_name == "invoke_mcp_tool":
            from .load_mcp_tools import InvokeMCPToolTool, LoadMCPToolsTool

            # If load_mcp_tools hasn't been created yet, create it first
            if self._load_tool_instance is None:
                self._load_tool_instance = LoadMCPToolsTool(
                    task_id=context.task_id,
                    subtask_id=context.subtask_id,
                    user_id=context.user_id,
                    timeout=timeout,
                )

            return InvokeMCPToolTool(
                load_mcp_tools_ref=self._load_tool_instance,
            )

        raise ValueError(f"Unknown tool: {tool_name}")

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate MCP tool configuration.

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
