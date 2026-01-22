# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox tool provider using E2B Sandbox API.

This module provides the SandboxToolProvider class that creates
various Sandbox tool instances for executing commands, managing files,
and running Claude AI tasks in isolated execution environments.

The tools use the E2B-like Sandbox API for lifecycle management:
- Sandbox creation and reuse
- Execution management
- HTTP polling for status

This provider is dynamically loaded from the skill directory at runtime.
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider


class SandboxToolProvider(SkillToolProvider):
    """Tool provider for Sandbox operations using E2B Sandbox API.

    This provider creates various Sandbox tool instances that allow
    Chat Shell agents to execute commands, manage files, and run Claude AI
    tasks in isolated Docker environments (ClaudeCode or Agno).

    Example SKILL.md configuration:
        tools:
          - name: sandbox_command
            provider: sandbox
          - name: sandbox_claude
            provider: sandbox
            config:
              command_timeout: 1800
          - name: sandbox_list_files
            provider: sandbox
    """

    def _prepare_base_params(
        self, context: SkillToolContext, tool_config: Optional[dict[str, Any]]
    ) -> dict[str, Any]:
        """Prepare common parameters for all Sandbox tools.

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
            "bot_config": config.get("bot_config", []),
            "default_shell_type": config.get("default_shell_type", "ClaudeCode"),
            "timeout": config.get("timeout", 7200),
        }

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "sandbox"
        """
        return "sandbox"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        Returns:
            List containing supported tool names
        """
        return [
            "sandbox_command",
            "sandbox_claude",
            "sandbox_list_files",
            "sandbox_read_file",
            "sandbox_write_file",
            "sandbox_upload_attachment",
            "sandbox_download_attachment",
        ]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a Sandbox tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies (task_id, subtask_id, ws_emitter, user_id)
            tool_config: Optional configuration with keys:
                - default_shell_type: Default shell type (default: "ClaudeCode")
                - timeout: Execution timeout in seconds (default: 7200)

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is unknown
        """
        import logging

        logger = logging.getLogger(__name__)

        logger.info(
            f"[SandboxProvider] ===== CREATE_TOOL START ===== tool_name={tool_name}, "
            f"task_id={context.task_id}, subtask_id={context.subtask_id}, "
            f"user_id={context.user_id}, user_name={context.user_name}"
        )

        # Prepare common parameters for all tools
        base_params = self._prepare_base_params(context, tool_config)
        config = tool_config or {}

        if tool_name == "sandbox_command":
            from .command_tool import SandboxCommandTool

            tool_instance = SandboxCommandTool(
                **base_params,
                default_command_timeout=config.get("command_timeout", 300),
            )

        elif tool_name == "sandbox_claude":
            from .claude_tool import SandboxClaudeTool

            tool_instance = SandboxClaudeTool(
                **base_params,
                default_command_timeout=config.get("command_timeout", 1800),
            )

        elif tool_name == "sandbox_list_files":
            from .list_files_tool import SandboxListFilesTool

            tool_instance = SandboxListFilesTool(**base_params)

        elif tool_name == "sandbox_read_file":
            from .read_file_tool import SandboxReadFileTool

            tool_instance = SandboxReadFileTool(
                **base_params,
                max_size=config.get("max_file_size", 1048576),  # 1MB default
            )

        elif tool_name == "sandbox_write_file":
            from .write_file_tool import SandboxWriteFileTool

            tool_instance = SandboxWriteFileTool(
                **base_params,
                max_size=config.get("max_file_size", 10485760),  # 10MB default
            )

        elif tool_name == "sandbox_upload_attachment":
            from .upload_attachment_tool import SandboxUploadAttachmentTool

            tool_instance = SandboxUploadAttachmentTool(
                **base_params,
                max_upload_size=config.get("max_file_size", 104857600),  # 100MB default
                auth_token=context.auth_token,  # Get auth_token from context
                api_base_url=config.get("api_base_url", ""),
            )

        elif tool_name == "sandbox_download_attachment":
            from .download_attachment_tool import SandboxDownloadAttachmentTool

            tool_instance = SandboxDownloadAttachmentTool(
                **base_params,
                auth_token=context.auth_token,  # Get auth_token from context
                api_base_url=config.get("api_base_url", ""),
            )

        else:
            raise ValueError(f"Unknown tool: {tool_name}")

        logger.info(
            f"[SandboxProvider] ===== TOOL INSTANCE CREATED ===== "
            f"tool_name={tool_instance.name}, "
            f"display_name={tool_instance.display_name}"
        )

        return tool_instance

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate Sandbox tool configuration.

        Args:
            tool_config: Configuration to validate

        Returns:
            True if valid, False otherwise
        """
        if not tool_config:
            return True

        # Validate shell_type if present
        shell_type = tool_config.get("default_shell_type")
        if shell_type is not None:
            if shell_type not in ["ClaudeCode", "Agno"]:
                return False

        # Validate timeout if present
        timeout = tool_config.get("timeout")
        if timeout is not None:
            if not isinstance(timeout, (int, float)):
                return False
            if timeout <= 0:
                return False

        return True
