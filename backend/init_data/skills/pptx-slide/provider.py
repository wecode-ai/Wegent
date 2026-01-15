# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""PPTX slide generation tool provider.

This module provides the PPTXToolProvider class that creates
CreatePPTXTool instances for skills that need to generate
PowerPoint presentations using E2B sandbox execution.
"""

from typing import Any, Optional

from chat_shell.skills import SkillToolContext, SkillToolProvider
from langchain_core.tools import BaseTool


class PPTXToolProvider(SkillToolProvider):
    """Tool provider for PPTX slide generation.

    This provider creates CreatePPTXTool instances that allow
    Chat Shell agents to generate PowerPoint presentations
    using python-pptx library executed in E2B sandbox.

    Example SKILL.md configuration:
        tools:
          - name: create_pptx
            provider: pptx
            config:
              timeout: 120
              max_retries: 3
    """

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "pptx"
        """
        return "pptx"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        Returns:
            List containing "create_pptx"
        """
        return ["create_pptx"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a PPTX tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies (task_id, subtask_id, ws_emitter, user_id)
            tool_config: Optional configuration with keys:
                - timeout: Execution timeout in seconds (default: 120)
                - max_retries: Maximum retry attempts (default: 3)

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is unknown
        """
        import logging

        logger = logging.getLogger(__name__)

        logger.info(
            f"[PPTXProvider] Creating tool: tool_name={tool_name}, "
            f"task_id={context.task_id}, subtask_id={context.subtask_id}, "
            f"user_id={context.user_id}"
        )

        if tool_name == "create_pptx":
            # Import from local module within this skill package
            from .create_pptx import CreatePPTXTool

            config = tool_config or {}

            tool_instance = CreatePPTXTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                ws_emitter=context.ws_emitter,
                user_id=context.user_id,
                user_name=context.user_name,
                timeout=config.get("timeout", 120),
                max_retries=config.get("max_retries", 3),
            )

            logger.info(
                f"[PPTXProvider] Tool instance created: "
                f"tool_name={tool_instance.name}, "
                f"display_name={tool_instance.display_name}"
            )

            return tool_instance
        else:
            raise ValueError(f"Unknown tool: {tool_name}")

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate PPTX tool configuration.

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

        # Validate max_retries if present
        max_retries = tool_config.get("max_retries")
        if max_retries is not None:
            if not isinstance(max_retries, int):
                return False
            if max_retries < 0 or max_retries > 10:
                return False

        return True
