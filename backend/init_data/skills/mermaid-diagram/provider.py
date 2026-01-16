# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Mermaid diagram tool provider (Python validation version).

This module provides the MermaidToolProvider class that creates
RenderMermaidTool instances for skills that declare mermaid tool dependencies.

This version uses pure Python validation instead of frontend WebSocket validation,
making it suitable for HTTP mode deployment where backend modules are not available.
"""

from typing import Any, Optional

from chat_shell.skills import SkillToolContext, SkillToolProvider
from langchain_core.tools import BaseTool


class MermaidToolProvider(SkillToolProvider):
    """Tool provider for mermaid diagram rendering (Python validation).

    This provider creates RenderMermaidTool instances for skills
    that declare mermaid tool dependencies.

    Unlike the original mermaid-diagram skill, this version uses pure Python
    syntax validation instead of frontend WebSocket validation, making it
    independent of backend modules and suitable for HTTP mode deployment.

    Example SKILL.md configuration:
        tools:
          - name: render_mermaid
            provider: mermaid
            config:
              timeout: 30
    """

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "mermaid"
        """
        return "mermaid"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        Returns:
            List containing "render_mermaid" and "read_mermaid_reference"
        """
        return ["render_mermaid", "read_mermaid_reference"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a mermaid tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies (task_id, subtask_id, ws_emitter)
            tool_config: Optional configuration with keys:
                - timeout: Render timeout in seconds (default: 30.0)

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is unknown
        """
        if tool_name == "render_mermaid":
            # Import from local module within this skill package
            from .render_mermaid import RenderMermaidTool

            return RenderMermaidTool()

        elif tool_name == "read_mermaid_reference":
            # Import from local module within this skill package
            from .read_reference import ReadMermaidReferenceTool

            return ReadMermaidReferenceTool()

        else:
            raise ValueError(f"Unknown tool: {tool_name}")

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate mermaid tool configuration.

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
