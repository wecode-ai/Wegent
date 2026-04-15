# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk file upload tool provider.

This module provides DingtalkFileUploadProvider class that creates
get_dingtalk_mcp_config tool instances for accessing user's DingTalk MCP
configuration from the database.
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider
from shared.models.execution import ExecutionRequest


class DingtalkFileUploadProvider(SkillToolProvider):
    """Tool provider for DingTalk file upload operations.

    This provider creates get_dingtalk_mcp_config tool instances that allow
    Chat Shell agents to access user's DingTalk MCP configuration for docs,
    table, and ai_table services.

    Example SKILL.md configuration:
        tools:
          - name: get_dingtalk_mcp_config
            provider: dingtalk_file_upload
    """

    def _prepare_base_params(
        self, context: SkillToolContext, tool_config: Optional[dict[str, Any]]
    ) -> dict[str, Any]:
        """Prepare common parameters for DingTalk config tools.

        Args:
            context: Context with dependencies
            tool_config: Optional configuration

        Returns:
            Dictionary with common parameters
        """
        return {
            "task_id": context.task_id,
            "subtask_id": context.subtask_id,
            "ws_emitter": context.ws_emitter,
            "user_id": context.user_id,
            "user_name": context.user_name,
        }

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "dingtalk_file_upload"
        """
        return "dingtalk_file_upload"

    @property
    def supported_tools(self) -> list[str]:
        """Return list of tools this provider can create.

        Returns:
            List containing "get_dingtalk_mcp_config"
        """
        return ["get_dingtalk_mcp_config"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a DingTalk file upload tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies (task_id, subtask_id, ws_emitter, user_id)
            tool_config: Optional configuration (not used for this provider)

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is unknown
        """
        if tool_name == "get_dingtalk_mcp_config":
            from .get_dingtalk_mcp_config import GetDingtalkMcpConfig

            base_params = self._prepare_base_params(context, tool_config)
            return GetDingtalkMcpConfig(**base_params)
        else:
            raise ValueError(f"Unknown tool: {tool_name}")

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate DingTalk file upload tool configuration.

        Args:
            tool_config: Configuration to validate

        Returns:
            True if valid, False otherwise
        """
        # No configuration needed for this provider
        return True