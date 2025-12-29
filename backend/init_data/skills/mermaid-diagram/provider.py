# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Mermaid diagram tool provider.

This module provides the MermaidToolProvider class that creates
RenderMermaidTool instances for skills that declare mermaid tool dependencies.

This provider is dynamically loaded from the skill directory at runtime.
The RenderMermaidTool implementation is now local to this skill package,
using the generic PendingRequestRegistry and emit_skill_request infrastructure.
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from app.chat_shell.skills import SkillToolContext, SkillToolProvider


class MermaidToolProvider(SkillToolProvider):
    """Tool provider for mermaid diagram rendering.

    This provider creates RenderMermaidTool instances for skills
    that declare mermaid tool dependencies.

    The tool implementation is now self-contained within this skill package,
    using the generic skill request/response infrastructure instead of
    mermaid-specific code in the core system.

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
            List containing "render_mermaid"
        """
        return ["render_mermaid"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a mermaid tool instance.

        Args:
            tool_name: Name of the tool to create (must be "render_mermaid")
            context: Context with dependencies (task_id, subtask_id, ws_emitter)
            tool_config: Optional configuration with keys:
                - timeout: Render timeout in seconds (default: 30.0)

        Returns:
            Configured RenderMermaidTool instance

        Raises:
            ValueError: If tool_name is not "render_mermaid"
        """
        if tool_name != "render_mermaid":
            raise ValueError(f"Unknown tool: {tool_name}")

        # Import from local module within this skill package
        from .render_mermaid import RenderMermaidTool

        config = tool_config or {}

        return RenderMermaidTool(
            task_id=context.task_id,
            subtask_id=context.subtask_id,
            ws_emitter=context.ws_emitter,
            render_timeout=config.get("timeout", 30.0),
        )

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
