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

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Bot, Team

logger = logging.getLogger(__name__)


@dataclass
class ChatConfig:
    """Complete configuration for a chat session.

    Contains all resolved configuration needed to start a chat stream.
    The system prompt is the base prompt from Ghost + team member prompt.
    Prompt enhancements (clarification, deep thinking, skills) are handled
    internally by chat_shell based on the enable_* flags.
    """

    # Model configuration
    model_config: dict[str, Any] = field(default_factory=dict)

    # Base system prompt (from Ghost + team member prompt, without enhancements)
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

    # Skill names for load_skill tool
    skill_names: list[str] = field(default_factory=list)

    # Full skill configurations including tools declarations
    # Used by SkillToolRegistry to dynamically create tool instances
    skill_configs: list[dict[str, Any]] = field(default_factory=list)

    # Preload skills list (resolved from Ghost CRD + frontend override)
    preload_skills: list[str] = field(default_factory=list)

    # User-selected skills (skills explicitly chosen by user for this message)
    # These skills will be highlighted in the system prompt to encourage the model to prioritize them
    user_selected_skills: list[str] = field(default_factory=list)

    # Prompt enhancement options (handled internally by chat_shell)
    enable_clarification: bool = False
    enable_deep_thinking: bool = True


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
        enable_deep_thinking: bool = True,
        task_id: int = 0,
        preload_skills: list | None = None,
    ) -> ChatConfig:
        """Build complete chat configuration.

        Args:
            override_model_name: Optional model name to override bot's model
            force_override: If True, override takes highest priority
            team_member_prompt: Optional additional prompt from team member
            enable_clarification: Whether to enable clarification mode
            enable_deep_thinking: Whether to enable deep thinking mode with search guidance
            task_id: Task ID for placeholder replacement
            preload_skills: Optional list of skills to preload into system prompt.
                Each item can be a dict with {name, namespace, is_public} or a SkillRef object.

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

        # Get skills for the bot (needed for load_skill tool and prompt enhancement)
        # Also get preload_skills from Ghost CRD
        # Pass user_preload_skills from frontend for dynamic skill loading
        skills, resolved_preload_skills, user_selected_skills = self._get_bot_skills(
            bot,
            user_preload_skills=preload_skills or [],
        )

        skill_names = [s["name"] for s in skills]

        # Get base system prompt (without enhancements - those are handled by chat_shell)
        system_prompt = self._get_base_system_prompt(bot, team_member_prompt)

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
            skill_names=skill_names,
            skill_configs=skills,  # Full skill configs
            preload_skills=resolved_preload_skills,  # Resolved from Ghost CRD + frontend
            user_selected_skills=user_selected_skills,  # Skills explicitly chosen by user
            enable_clarification=enable_clarification,
            enable_deep_thinking=enable_deep_thinking,
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
        from app.services.chat.config.model_resolver import (
            _process_model_config_placeholders,
            get_model_config_for_bot,
        )

        # Get base model config (extracts from DB and handles env placeholders + decryption)
        # Use self.user_id instead of self.team.user_id to support:
        # 1. Flow tasks where Flow owner may have different models than Team owner
        # 2. User's private models should be accessible based on the current user
        model_config = get_model_config_for_bot(
            self.db,
            bot,
            self.user_id,
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

    def _get_base_system_prompt(
        self,
        bot: Kind,
        team_member_prompt: str | None,
    ) -> str:
        """Get base system prompt for the bot (without enhancements).

        This method returns only the base system prompt from Ghost + team member prompt.
        Prompt enhancements (clarification, deep thinking, skills) are handled
        internally by chat_shell based on the enable_* flags in ChatConfig.

        Args:
            bot: Bot Kind object
            team_member_prompt: Optional additional prompt from team member

        Returns:
            Base system prompt (Ghost prompt + team member prompt)
        """
        from app.services.chat.config.model_resolver import get_bot_system_prompt

        # Get team member prompt from first member if not provided
        if team_member_prompt is None and self._team_crd.spec.members:
            team_member_prompt = self._team_crd.spec.members[0].prompt

        # Get base system prompt (no enhancements applied here)
        return get_bot_system_prompt(
            self.db,
            bot,
            self.team.user_id,
            team_member_prompt,
        )

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

    def _build_skill_data(self, skill: Kind) -> dict:
        """Build skill data dictionary from a Skill Kind object.

        Args:
            skill: Skill Kind object from database

        Returns:
            Dictionary containing skill metadata for chat configuration
        """
        from app.schemas.kind import Skill

        skill_crd = Skill.model_validate(skill.json)

        skill_data = {
            "name": skill_crd.metadata.name,
            "description": skill_crd.spec.description,
            "prompt": skill_crd.spec.prompt,
            "displayName": skill_crd.spec.displayName,
            "skill_id": skill.id,
            "skill_user_id": skill.user_id,
        }

        # Include optional fields if present
        if skill_crd.spec.config:
            skill_data["config"] = skill_crd.spec.config

        if skill_crd.spec.mcpServers:
            skill_data["mcpServers"] = skill_crd.spec.mcpServers

        if skill_crd.spec.tools:
            skill_data["tools"] = [
                tool.model_dump(exclude_none=True) for tool in skill_crd.spec.tools
            ]

        if skill_crd.spec.provider:
            skill_data["provider"] = {
                "module": skill_crd.spec.provider.module,
                "class": skill_crd.spec.provider.class_name,
            }
            # For HTTP mode: include download URL for remote skill binary loading
            # Only for public skills (user_id=0) for security
            if skill.user_id == 0:
                from app.core.config import settings

                base_url = settings.BACKEND_INTERNAL_URL.rstrip("/")
                skill_data["binary_download_url"] = (
                    f"{base_url}/api/internal/skills/{skill.id}/binary"
                )

        return skill_data

    def _get_bot_skills(
        self,
        bot: Kind,
        user_preload_skills: list | None = None,
    ) -> tuple[list[dict], list[str], list[str]]:
        """Get skills for the bot from Ghost, plus any additional skills from frontend.

        Returns tuple of:
        - List of skill metadata including tools configuration
        - List of resolved preload skill names (from Ghost CRD + user selected skills)
        - List of user-selected skill names (skills explicitly chosen by user for this message)

        The tools field contains tool declarations from SKILL.md frontmatter,
        which are used by SkillToolRegistry to dynamically create tool instances.

        Args:
            bot: Bot Kind object
            user_preload_skills: Optional list of user-selected skills to preload.
                Each item can be a dict with {name, namespace, is_public} or a SkillRef object.

        Returns:
            Tuple of (skills, preload_skills, user_selected_skills)
        """
        from app.schemas.kind import Ghost

        bot_crd = Bot.model_validate(bot.json)
        logger.info(
            "[_get_bot_skills] Bot: name=%s, ghostRef=%s",
            bot.name,
            bot_crd.spec.ghostRef if bot_crd.spec else None,
        )

        if not bot_crd.spec or not bot_crd.spec.ghostRef:
            logger.warning(
                "[_get_bot_skills] Bot has no ghostRef, returning empty skills"
            )
            return [], [], []

        # Query Ghost
        ghost = (
            self.db.query(Kind)
            .filter(
                Kind.user_id == self.team.user_id,
                Kind.kind == "Ghost",
                Kind.name == bot_crd.spec.ghostRef.name,
                Kind.namespace == bot_crd.spec.ghostRef.namespace,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not ghost or not ghost.json:
            logger.warning(
                "[_get_bot_skills] Ghost not found: name=%s, namespace=%s",
                bot_crd.spec.ghostRef.name,
                bot_crd.spec.ghostRef.namespace,
            )
            return [], [], []

        ghost_crd = Ghost.model_validate(ghost.json)
        logger.info(
            "[_get_bot_skills] Ghost: name=%s, skills=%s, preload_skills=%s",
            ghost.name,
            ghost_crd.spec.skills,
            ghost_crd.spec.preload_skills,
        )

        # Initialize result containers
        skills: list[dict] = []
        preload_skills: list[str] = []
        user_selected_skills: list[str] = []  # Track user-selected skills separately
        existing_skill_names: set[str] = set()

        # Build preload set from Ghost CRD
        ghost_preload_set = set(ghost_crd.spec.preload_skills or [])

        # Process Ghost skills
        if ghost_crd.spec.skills:
            for skill_name in ghost_crd.spec.skills:
                skill = self._find_skill(skill_name)
                if skill:
                    skill_data = self._build_skill_data(skill)
                    skills.append(skill_data)
                    existing_skill_names.add(skill_name)

                    # Add to preload if configured in Ghost
                    if skill_name in ghost_preload_set:
                        preload_skills.append(skill_name)
                        logger.info(
                            "[_get_bot_skills] Skill '%s' added to preload (from Ghost)",
                            skill_name,
                        )

        # Process user-selected skills from frontend
        if user_preload_skills:
            logger.info(
                "[_get_bot_skills] Processing %d user-selected skills: %s",
                len(user_preload_skills),
                user_preload_skills,
            )

            for add_skill in user_preload_skills:
                # Handle both dict and Pydantic model (SkillRef)
                if isinstance(add_skill, BaseModel):
                    # Pydantic model - access attributes directly
                    skill_name = add_skill.name
                    skill_namespace = getattr(add_skill, "namespace", "default")
                    is_public = getattr(add_skill, "is_public", False)
                else:
                    # Dict - use .get() method
                    skill_name = add_skill.get("name")
                    skill_namespace = add_skill.get("namespace", "default")
                    is_public = add_skill.get("is_public", False)

                # Check if already processed from Ghost skills
                if skill_name in existing_skill_names:
                    # Skill exists, just add to preload if not already there
                    if skill_name not in preload_skills:
                        preload_skills.append(skill_name)
                    # Always mark as user-selected since user explicitly chose it
                    if skill_name not in user_selected_skills:
                        user_selected_skills.append(skill_name)
                    logger.info(
                        "[_get_bot_skills] Skill '%s' added to preload and user_selected (user selected, already in Ghost)",
                        skill_name,
                    )
                    continue

                # Find and add new skill
                skill = self._find_skill_by_ref(skill_name, skill_namespace, is_public)
                if skill:
                    skill_data = self._build_skill_data(skill)
                    skills.append(skill_data)
                    existing_skill_names.add(skill_name)
                    preload_skills.append(skill_name)
                    user_selected_skills.append(skill_name)  # Mark as user-selected
                    logger.info(
                        "[_get_bot_skills] Added user-selected skill '%s' to skills, preload, and user_selected",
                        skill_name,
                    )
                else:
                    logger.warning(
                        "[_get_bot_skills] User-selected skill not found: name=%s, namespace=%s, is_public=%s",
                        skill_name,
                        skill_namespace,
                        is_public,
                    )

        logger.info(
            "[_get_bot_skills] Final result: preload_skills=%s, user_selected_skills=%s, total skills=%d",
            preload_skills,
            user_selected_skills,
            len(skills),
        )
        return skills, preload_skills, user_selected_skills

    def _find_skill_by_ref(
        self, skill_name: str, namespace: str, is_public: bool
    ) -> Kind | None:
        """Find skill by name, namespace, and public flag.

        This method is used for additional skills from frontend where we have
        explicit namespace and is_public information.

        Args:
            skill_name: Skill name
            namespace: Skill namespace
            is_public: Whether the skill is public (user_id=0)

        Returns:
            Skill Kind object or None if not found
        """
        if is_public:
            # Public skill (user_id=0)
            return (
                self.db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Skill",
                    Kind.name == skill_name,
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )
        else:
            # User's skill - search in specified namespace first, then default
            skill = (
                self.db.query(Kind)
                .filter(
                    Kind.user_id == self.user_id,
                    Kind.kind == "Skill",
                    Kind.name == skill_name,
                    Kind.namespace == namespace,
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )
            if skill:
                return skill

            # Fallback to default namespace
            if namespace != "default":
                return (
                    self.db.query(Kind)
                    .filter(
                        Kind.user_id == self.user_id,
                        Kind.kind == "Skill",
                        Kind.name == skill_name,
                        Kind.namespace == "default",
                        Kind.is_active == True,  # noqa: E712
                    )
                    .first()
                )
            return None

    def _find_skill(self, skill_name: str) -> Kind | None:
        """Find skill by name.

        Search order:
        1. User's skill in default namespace (personal)
        2. ANY skill in team's namespace (group-level, from any user)
        3. Public skill (user_id=0)
        """
        # Get team namespace for group-level skill lookup
        team_namespace = self.team.namespace if self.team.namespace else "default"

        # 1. User's personal skill (default namespace)
        skill = (
            self.db.query(Kind)
            .filter(
                Kind.user_id == self.team.user_id,
                Kind.kind == "Skill",
                Kind.name == skill_name,
                Kind.namespace == "default",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if skill:
            return skill

        # 2. Group-level skill (team's namespace) - search ALL skills in namespace
        # This allows any team member's skill to be used by other members
        if team_namespace != "default":
            skill = (
                self.db.query(Kind)
                .filter(
                    Kind.kind == "Skill",
                    Kind.name == skill_name,
                    Kind.namespace == team_namespace,
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )

            if skill:
                return skill

        # 3. Public skill (user_id=0)
        return (
            self.db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Skill",
                Kind.name == skill_name,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
