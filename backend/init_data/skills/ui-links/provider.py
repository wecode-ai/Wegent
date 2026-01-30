# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""UI links tool provider.

Provides tools for generating UI-ready markdown links for attachment:// and
wegent:// schemes.
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider


class UiLinksToolProvider(SkillToolProvider):
    """Tool provider for UI link generation."""

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md."""
        return "ui-links"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create."""
        return ["ui_attachment_link", "ui_wegent_link"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a UI link tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies (task_id, user_id, user_name, auth_token)
            tool_config: Optional configuration

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is unknown
        """
        import logging

        logger = logging.getLogger(__name__)
        config = tool_config or {}

        logger.info(
            f"[UiLinksProvider] Creating tool: {tool_name}, "
            f"task_id={context.task_id}, user_id={context.user_id}, user_name={context.user_name}"
        )

        if tool_name == "ui_attachment_link":
            from .attachment_link_tool import UiAttachmentLinkTool

            tool_instance = UiAttachmentLinkTool(
                task_id=context.task_id,
                user_id=context.user_id,
                user_name=context.user_name,
                auth_token=context.auth_token,
                api_base_url=config.get("api_base_url", ""),
            )

        elif tool_name == "ui_wegent_link":
            from .wegent_link_tool import UiWegentLinkTool

            tool_instance = UiWegentLinkTool(
                task_id=context.task_id,
                user_id=context.user_id,
                user_name=context.user_name,
            )

        else:
            raise ValueError(f"Unknown tool: {tool_name}")

        logger.info(
            f"[UiLinksProvider] Tool created: name={tool_instance.name}, "
            f"display_name={tool_instance.display_name}"
        )

        return tool_instance

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate tool configuration.

        Args:
            tool_config: Configuration to validate

        Returns:
            True if valid, False otherwise
        """
        if not tool_config:
            return True

        api_base_url = tool_config.get("api_base_url")
        if api_base_url is not None and not isinstance(api_base_url, str):
            return False

        return True
