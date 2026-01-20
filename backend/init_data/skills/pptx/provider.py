# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""PPTX skill provider for generating PowerPoint presentations."""

from __future__ import annotations

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills.context import SkillToolContext
from chat_shell.skills.provider import SkillToolProvider

from .pptx_tool import PPTXGenerateTool


class PPTXToolProvider(SkillToolProvider):
    """Provider for PPTX generation tools."""

    @property
    def provider_name(self) -> str:
        """Return the provider name for tool registration."""
        return "pptx"

    @property
    def supported_tools(self) -> list[str]:
        """Return list of tool names this provider supports."""
        return ["generate_pptx"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Skill execution context with task/user info
            tool_config: Optional configuration for the tool

        Returns:
            BaseTool instance

        Raises:
            ValueError: If tool_name is not supported
        """
        config = tool_config or {}

        if tool_name == "generate_pptx":
            return PPTXGenerateTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                user_id=context.user_id,
                user_name=context.user_name,
                ws_emitter=context.ws_emitter,
                max_slides=config.get("max_slides", 50),
                timeout=config.get("timeout", 120),
            )
        else:
            raise ValueError(
                f"Unknown tool '{tool_name}'. Supported tools: {self.supported_tools}"
            )
