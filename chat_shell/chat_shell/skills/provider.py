# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Abstract base class for skill tool providers.

This module defines the SkillToolProvider interface that all
tool providers must implement to integrate with the skill system.
"""

from abc import ABC, abstractmethod
from typing import Any, Optional

from langchain_core.tools import BaseTool

from .context import SkillToolContext


class SkillToolProvider(ABC):
    """Abstract base class for skill tool providers.

    A tool provider is responsible for creating tool instances
    for a specific skill. Each provider is registered with a
    unique provider name and can create one or more tools.

    Example:
        class MySkillToolProvider(SkillToolProvider):
            @property
            def provider_name(self) -> str:
                return "my-skill"

            @property
            def supported_tools(self) -> list[str]:
                return ["my_tool"]

            def create_tool(
                self,
                tool_name: str,
                context: SkillToolContext,
                tool_config: dict[str, Any]
            ) -> BaseTool:
                if tool_name == "my_tool":
                    return MyTool(
                        task_id=context.task_id,
                        subtask_id=context.subtask_id,
                        ws_emitter=context.ws_emitter,
                    )
                raise ValueError(f"Unknown tool: {tool_name}")
    """

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Unique identifier for this provider.

        This name is used in SKILL.md to reference the provider:

        tools:
          - name: my_tool
            provider: my-skill  # <-- provider_name

        Returns:
            Provider name string
        """
        pass

    @property
    @abstractmethod
    def supported_tools(self) -> list[str]:
        """List of tool names this provider can create.

        Returns:
            List of supported tool names
        """
        pass

    @abstractmethod
    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies
            tool_config: Optional tool-specific configuration

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is not supported
        """
        pass

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate tool configuration.

        Override this method to add custom validation logic.

        Args:
            tool_config: Configuration to validate

        Returns:
            True if valid, False otherwise
        """
        return True
