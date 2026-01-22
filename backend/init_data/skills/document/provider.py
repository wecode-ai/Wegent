# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document skill loader tool provider.

This module provides the DocumentToolProvider class that creates
document skill loader tool instances for loading Anthropic's official
document generation skills (PPTX, XLSX, DOCX, PDF) from Claude marketplace.

The provider depends on the sandbox skill for command execution and file operations.
"""

from typing import Any, Optional

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider


class DocumentToolProvider(SkillToolProvider):
    """Tool provider for document skill loading operations.

    This provider creates document skill loader tool instances that allow
    Chat Shell agents to load Anthropic's official document generation skills
    (PPTX, XLSX, DOCX, PDF) from the Claude marketplace.

    Dependencies:
        - sandbox skill: Required for command execution and file operations

    Example SKILL.md configuration:
        tools:
          - name: load_document_skill
            provider: document
            config:
              timeout: 300
    """

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md.

        Returns:
            The string "document"
        """
        return "document"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create.

        Returns:
            List containing supported tool names
        """
        return ["load_document_skill"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a document skill loader tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies (task_id, user_id, user_name)
            tool_config: Optional configuration with keys:
                - timeout: Execution timeout in seconds (default: 300)

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is unknown
        """
        import logging

        logger = logging.getLogger(__name__)

        logger.info(
            f"[DocumentProvider] Creating tool: {tool_name}, "
            f"task_id={context.task_id}, user_id={context.user_id}, user_name={context.user_name}"
        )

        if tool_name == "load_document_skill":
            from .document_tool import LoadDocumentSkillTool

            tool_instance = LoadDocumentSkillTool(
                task_id=context.task_id,
                user_id=context.user_id,
                user_name=context.user_name,
            )

        else:
            raise ValueError(f"Unknown tool: {tool_name}")

        logger.info(
            f"[DocumentProvider] ===== TOOL INSTANCE CREATED ===== "
            f"tool_name={tool_instance.name}, "
            f"display_name={tool_instance.display_name}"
        )

        return tool_instance

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate document tool configuration.

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
