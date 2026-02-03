# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser tool provider using Playwright for browser automation.

This module provides the BrowserToolProvider class that creates
various browser automation tool instances for navigating pages,
clicking elements, filling forms, and taking screenshots.

Architecture:
- tools/ - Python tool definitions (sent to LLM)
- scripts/ - JS scripts executed in sandbox (Playwright Node.js API)

All browser operations are executed in an isolated sandbox container.
This provider is dynamically loaded from the skill directory at runtime.
"""

import logging
from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider

logger = logging.getLogger(__name__)


class BrowserToolProvider(SkillToolProvider):
    """Tool provider for browser automation operations using Playwright.

    This provider creates various browser tool instances that allow
    Chat Shell agents to automate browser interactions in isolated
    sandbox environments.

    Example SKILL.md configuration:
        tools:
          - name: browser_navigate
            provider: browser
          - name: browser_click
            provider: browser
          - name: browser_fill
            provider: browser
          - name: browser_screenshot
            provider: browser
            config:
              default_timeout: 30
    """

    def _prepare_base_params(
        self, context: SkillToolContext, tool_config: Optional[dict[str, Any]]
    ) -> dict[str, Any]:
        """Prepare common parameters for all Browser tools.

        Args:
            context: Context with dependencies
            tool_config: Optional configuration

        Returns:
            Dictionary with common parameters
        """
        config = tool_config or {}

        return {
            "task_id": context.task_id,
            "subtask_id": context.subtask_id,
            "ws_emitter": context.ws_emitter,
            "user_id": context.user_id,
            "user_name": context.user_name,
            "default_timeout": config.get("default_timeout", 30),
        }

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "browser"
        """
        return "browser"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        Returns:
            List containing supported tool names
        """
        return [
            "browser_navigate",
            "browser_click",
            "browser_fill",
            "browser_screenshot",
        ]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a Browser tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies (task_id, subtask_id, ws_emitter, user_id)
            tool_config: Optional configuration with keys:
                - default_timeout: Default timeout in seconds (default: 30)

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is unknown
        """
        logger.info(
            f"[BrowserProvider] ===== CREATE_TOOL START ===== tool_name={tool_name}, "
            f"task_id={context.task_id}, subtask_id={context.subtask_id}, "
            f"user_id={context.user_id}, user_name={context.user_name}"
        )

        # Prepare common parameters for all tools
        base_params = self._prepare_base_params(context, tool_config)

        if tool_name == "browser_navigate":
            from .tools.navigate import BrowserNavigateTool

            tool_instance = BrowserNavigateTool(**base_params)

        elif tool_name == "browser_click":
            from .tools.click import BrowserClickTool

            tool_instance = BrowserClickTool(**base_params)

        elif tool_name == "browser_fill":
            from .tools.fill import BrowserFillTool

            tool_instance = BrowserFillTool(**base_params)

        elif tool_name == "browser_screenshot":
            from .tools.screenshot import BrowserScreenshotTool

            tool_instance = BrowserScreenshotTool(**base_params)

        else:
            raise ValueError(f"Unknown tool: {tool_name}")

        logger.info(
            f"[BrowserProvider] ===== TOOL INSTANCE CREATED ===== "
            f"tool_name={tool_instance.name}, "
            f"display_name={tool_instance.display_name}"
        )

        return tool_instance

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate Browser tool configuration.

        Args:
            tool_config: Configuration to validate

        Returns:
            True if valid, False otherwise
        """
        if not tool_config:
            return True

        # Validate timeout if present
        timeout = tool_config.get("default_timeout")
        if timeout is not None:
            if not isinstance(timeout, (int, float)):
                return False
            if timeout <= 0:
                return False

        return True
