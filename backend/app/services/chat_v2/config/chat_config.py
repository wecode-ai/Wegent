# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat configuration builder for LangGraph Chat Service.

This module centralizes the configuration preparation logic for chat sessions,
including Bot, Model, Ghost resolution and system prompt building.
"""

import logging
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Bot, Team

logger = logging.getLogger(__name__)


@dataclass
class ChatConfig:
    """Complete configuration for a chat session.

    Contains all resolved configuration needed to start a chat stream.
    """

    # Model configuration
    model_config: dict[str, Any] = field(default_factory=dict)

    # System prompt (combined from Ghost + team member prompt + clarification)
    system_prompt: str = ""

    # Bot information
    bot_name: str = ""
    bot_namespace: str = "default"
    shell_type: str = "Chat"  # Shell type from bot (Chat, ClaudeCode, Agno, etc.)

    # Agent configuration from bot
    agent_config: dict[str, Any] = field(default_factory=dict)

    # User information for placeholder replacement
    user_id: int = 0
    user_name: str = ""

    # Task information
    task_id: int = 0
    team_id: int = 0


class ChatConfigBuilder:
    """Builder for chat configuration.

    Centralizes the logic for resolving Bot, Model, Ghost and building
    the complete configuration needed for a chat session.

    Usage:
        builder = ChatConfigBuilder(db, team, user_id)
        config = builder.build(
            override_model_name=payload.force_override_bot_model,
            enable_clarification=payload.enable_clarification,
        )
    """

    def __init__(
        self,
        db: Session,
        team: Kind,
        user_id: int,
        user_name: str = "",
    ):
        """Initialize config builder.

        Args:
            db: Database session
            team: Team Kind object
            user_id: User ID
            user_name: User name for placeholder replacement
        """
        self.db = db
        self.team = team
        self.user_id = user_id
        self.user_name = user_name

        # Parse team CRD
        self._team_crd = Team.model_validate(team.json)

        # Cache shell_type for the first bot to avoid repeated database queries
        self._cached_shell_type: str | None = None

    def build(
        self,
        override_model_name: str | None = None,
        force_override: bool = False,
        team_member_prompt: str | None = None,
        enable_clarification: bool = False,
        enable_deep_thinking: bool = False,
        task_id: int = 0,
    ) -> ChatConfig:
        """Build complete chat configuration.

        Args:
            override_model_name: Optional model name to override bot's model
            force_override: If True, override takes highest priority
            team_member_prompt: Optional additional prompt from team member
            enable_clarification: Whether to enable clarification mode
            enable_deep_thinking: Whether to enable deep thinking mode with search guidance
            task_id: Task ID for placeholder replacement

        Returns:
            Complete ChatConfig ready for streaming
        """
        # Get first bot from team
        bot = self._get_first_bot()
        if not bot:
            raise ValueError(f"No bot found for team {self.team.name}")

        # Get model config
        model_config = self._get_model_config(
            bot,
            override_model_name,
            force_override,
            task_id,
        )

        # Get system prompt
        system_prompt = self._get_system_prompt(
            bot,
            team_member_prompt,
            enable_clarification,
            enable_deep_thinking,
        )

        # Get agent config
        bot_spec = bot.json.get("spec", {}) if bot.json else {}
        agent_config = bot_spec.get("agent_config", {})

        # Parse bot CRD for name/namespace
        bot_crd = Bot.model_validate(bot.json)

        # Get shell_type from cache or query database (only once per builder instance)
        if self._cached_shell_type is None:
            self._cached_shell_type = self._resolve_shell_type(bot_crd)
        shell_type = self._cached_shell_type

        return ChatConfig(
            model_config=model_config,
            system_prompt=system_prompt,
            bot_name=bot_crd.metadata.name if bot_crd.metadata else bot.name,
            bot_namespace=bot_crd.metadata.namespace if bot_crd.metadata else "default",
            shell_type=shell_type,
            agent_config=agent_config,
            user_id=self.user_id,
            user_name=self.user_name,
            task_id=task_id,
            team_id=self.team.id,
        )

    def _get_first_bot(self) -> Kind | None:
        """Get the first bot from team members.

        Returns:
            Bot Kind object or None if not found
        """
        if not self._team_crd.spec.members:
            logger.error("Team %s has no members", self.team.name)
            return None

        first_member = self._team_crd.spec.members[0]

        bot = (
            self.db.query(Kind)
            .filter(
                Kind.user_id == self.team.user_id,
                Kind.kind == "Bot",
                Kind.name == first_member.botRef.name,
                Kind.namespace == first_member.botRef.namespace,
                Kind.is_active,
            )
            .first()
        )

        if not bot:
            logger.error(
                "Bot not found: name=%s, namespace=%s",
                first_member.botRef.name,
                first_member.botRef.namespace,
            )

        return bot

    def _get_model_config(
        self,
        bot: Kind,
        override_model_name: str | None,
        force_override: bool,
        task_id: int,
    ) -> dict[str, Any]:
        """Get model configuration for the bot.

        Args:
            bot: Bot Kind object
            override_model_name: Optional model name override
            force_override: Whether override takes priority
            task_id: Task ID for placeholder replacement

        Returns:
            Model configuration dictionary
        """
        from app.services.chat_v2.models.resolver import (
            _process_model_config_placeholders,
            get_model_config_for_bot,
        )

        # Get base model config (extracts from DB and handles env placeholders + decryption)
        model_config = get_model_config_for_bot(
            self.db,
            bot,
            self.team.user_id,
            override_model_name=override_model_name,
            force_override=force_override,
        )

        # Build agent_config and task_data for placeholder replacement
        bot_spec = bot.json.get("spec", {}) if bot.json else {}
        agent_config = bot_spec.get("agent_config", {})
        user_info = {"id": self.user_id, "name": self.user_name}
        task_data = {
            "task_id": task_id,
            "team_id": self.team.id,
            "user": user_info,
        }

        # Process all placeholders in model_config (api_key + default_headers)
        model_config = _process_model_config_placeholders(
            model_config=model_config,
            user_id=self.user_id,
            user_name=self.user_name,
            agent_config=agent_config,
            task_data=task_data,
        )

        return model_config

    def _get_system_prompt(
        self,
        bot: Kind,
        team_member_prompt: str | None,
        enable_clarification: bool,
        enable_deep_thinking: bool,
    ) -> str:
        """Get system prompt for the bot.

        Args:
            bot: Bot Kind object
            team_member_prompt: Optional additional prompt from team member
            enable_clarification: Whether to enable clarification mode
            enable_deep_thinking: Whether to enable deep thinking mode with search guidance

        Returns:
            Combined system prompt
        """
        from datetime import datetime

        from app.services.chat_v2.models.resolver import get_bot_system_prompt

        # Get team member prompt from first member if not provided
        if team_member_prompt is None and self._team_crd.spec.members:
            team_member_prompt = self._team_crd.spec.members[0].prompt

        # Get base system prompt
        system_prompt = get_bot_system_prompt(
            self.db,
            bot,
            self.team.user_id,
            team_member_prompt,
        )

        # Append current date/time information
        now = datetime.now()
        current_time_info = (
            f"\n\nCurrent date and time: {now.strftime('%Y-%m-%d %H:%M:%S')}\n"
        )
        system_prompt += current_time_info

        # Append clarification mode instructions if enabled
        if enable_clarification:
            from app.services.chat_v2.utils.prompts import (
                append_clarification_prompt,
            )

            system_prompt = append_clarification_prompt(system_prompt, True)

        # Append deep thinking mode instructions if enabled
        if enable_deep_thinking:
            from app.services.chat_v2.utils.prompts import (
                append_deep_thinking_prompt,
            )

            system_prompt = append_deep_thinking_prompt(system_prompt, True)

        # CRITICAL: Log the final system prompt being sent to the LLM
        logger.info(
            "[SYSTEM_PROMPT_DEBUG] Final system prompt for bot '%s' (user_id=%d, team_id=%d):\n---\n%s\n---",
            bot.name if bot else "UNKNOWN_BOT",
            self.user_id,
            self.team.id,
            system_prompt,
        )

        return system_prompt

    def get_first_member_prompt(self) -> str | None:
        """Get the prompt from the first team member.

        Returns:
            Team member prompt or None
        """
        if self._team_crd.spec.members:
            return self._team_crd.spec.members[0].prompt
        return None

    def _resolve_shell_type(self, bot_crd: Bot) -> str:
        """Resolve shell_type from bot's shellRef.

        This method queries the Shell CRD to get the shell_type.
        It's called once per builder instance and the result is cached.

        Args:
            bot_crd: Parsed Bot CRD

        Returns:
            Shell type string (e.g., "Chat", "ClaudeCode", "Agno")
        """
        from app.schemas.kind import Shell

        # Default value
        shell_type = "Chat"

        if not (bot_crd.spec and bot_crd.spec.shellRef):
            return shell_type

        shell_ref = bot_crd.spec.shellRef

        # Query user's private shell first
        shell = (
            self.db.query(Kind)
            .filter(
                Kind.user_id == self.user_id,
                Kind.kind == "Shell",
                Kind.name == shell_ref.name,
                Kind.namespace == shell_ref.namespace,
                Kind.is_active,
            )
            .first()
        )

        # If not found in user's shells, try public shells (user_id = 0)
        if not shell:
            shell = (
                self.db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Shell",
                    Kind.name == shell_ref.name,
                    Kind.is_active,
                )
                .first()
            )

        # Extract shell_type from Shell CRD
        if shell and shell.json:
            shell_crd = Shell.model_validate(shell.json)
            if shell_crd.spec and shell_crd.spec.shellType:
                shell_type = shell_crd.spec.shellType

        logger.debug(
            "[ChatConfigBuilder] Resolved shell_type=%s for bot=%s (shell_ref=%s/%s)",
            shell_type,
            bot_crd.metadata.name if bot_crd.metadata else "unknown",
            shell_ref.namespace,
            shell_ref.name,
        )

        return shell_type
