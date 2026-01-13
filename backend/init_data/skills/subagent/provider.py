# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SubAgent tool provider using E2B Sandbox API.

This module provides the SubAgentToolProvider class that creates
CreateSubAgentTaskTool instances for skills that need to delegate
complex tasks to SubAgents running in isolated execution environments.

The tool uses the E2B-like Sandbox API for lifecycle management:
- Sandbox creation and reuse
- Execution management
- HTTP polling for status

This provider is dynamically loaded from the skill directory at runtime.
"""

from typing import Any, Optional

from chat_shell.skills import SkillToolContext, SkillToolProvider
from langchain_core.tools import BaseTool


class SubAgentToolProvider(SkillToolProvider):
    """Tool provider for SubAgent task creation using E2B Sandbox API.

    This provider creates CreateSubAgentTaskTool instances that allow
    Chat Shell agents to delegate complex tasks to SubAgents running
    in isolated Docker environments (ClaudeCode or Agno).

    Example SKILL.md configuration:
        tools:
          - name: create_subagent_task
            provider: subagent
            config:
              default_shell_type: "ClaudeCode"
              timeout: 7200  # Execution timeout in seconds
    """

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "subagent"
        """
        return "subagent"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        Returns:
            List containing "create_subagent_task"
        """
        return ["create_subagent_task"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a SubAgent tool instance.

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
            f"[SubAgentProvider] ===== CREATE_TOOL START ===== tool_name={tool_name}, "
            f"task_id={context.task_id}, subtask_id={context.subtask_id}, "
            f"user_id={context.user_id}, user_name={context.user_name}"
        )

        if tool_name == "create_subagent_task":
            # Import from local module within this skill package
            from .create_subagent_task import CreateSubAgentTaskTool

            config = tool_config or {}

            # Get bot config from tool config (list of {shell_type, agent_config})
            bot_config = config.get("bot_config", [])

            logger.info(
                f"[SubAgentProvider] Bot config from tool_config: "
                f"has_config={bool(bot_config)}, "
                f"count={len(bot_config) if bot_config else 0}"
            )

            # Log first bot config details if available
            if bot_config and len(bot_config) > 0:
                first_config = bot_config[0]
                agent_config = first_config.get("agent_config", {})
                env_config = agent_config.get("env", {})
                logger.info(
                    f"[SubAgentProvider] First bot config details: "
                    f"shell_type={first_config.get('shell_type')}, "
                    f"model={env_config.get('model')}, "
                    f"has_api_key={bool(env_config.get('api_key'))}, "
                    f"base_url={env_config.get('base_url')}, "
                    f"model_id={env_config.get('model_id')}"
                )

            tool_instance = CreateSubAgentTaskTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                ws_emitter=context.ws_emitter,
                user_id=context.user_id,
                user_name=context.user_name,
                bot_config=bot_config,
                default_shell_type=config.get("default_shell_type", "ClaudeCode"),
                timeout=config.get("timeout", 7200),
            )

            logger.info(
                f"[SubAgentProvider] ===== TOOL INSTANCE CREATED ===== "
                f"has_bot_config={bool(tool_instance.bot_config)}, "
                f"tool_name={tool_instance.name}, "
                f"display_name={tool_instance.display_name}"
            )

            return tool_instance
        else:
            raise ValueError(f"Unknown tool: {tool_name}")

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate SubAgent tool configuration.

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
