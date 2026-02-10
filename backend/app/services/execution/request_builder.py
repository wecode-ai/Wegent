# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified task request builder for execution.

Builds ExecutionRequest from database models with full CRD resolution.
This module consolidates the logic from the former ChatConfigBuilder,
providing complete Bot, Model, Ghost, Shell, and Skill resolution.
"""

import logging
from typing import Any, List, Optional

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.schemas.kind import Bot, Ghost, Shell, Team
from shared.models import ExecutionRequest
from shared.models.db import Kind, User

logger = logging.getLogger(__name__)


class TaskRequestBuilder:
    """Unified task request builder.

    Builds ExecutionRequest from database models with full CRD resolution.
    This class consolidates the logic from the former ChatConfigBuilder,
    providing complete Bot, Model, Ghost, Shell, and Skill resolution.

    Usage:
        builder = TaskRequestBuilder(db)
        request = builder.build(
            subtask=subtask,
            task=task,
            user=user,
            team=team,
            message=message,
            override_model_name="gpt-4",
            preload_skills=["skill1", "skill2"],
        )
    """

    def __init__(self, db: Session):
        """Initialize the task request builder.

        Args:
            db: Database session
        """
        self.db = db
        # Cache shell_type to avoid repeated database queries
        self._cached_shell_type: str | None = None

    def build(
        self,
        subtask: Subtask,
        task: TaskResource,
        user: User,
        team: Kind,
        message: str,
        *,
        # Feature toggles
        enable_tools: bool = True,
        enable_web_search: bool = False,
        enable_clarification: bool = False,
        enable_deep_thinking: bool = True,
        # Skill configuration
        skill_names: Optional[List[str]] = None,
        preload_skills: Optional[List[str]] = None,
        user_selected_skills: Optional[List[str]] = None,
        # Knowledge base
        knowledge_base_ids: Optional[List[int]] = None,
        document_ids: Optional[List[int]] = None,
        is_user_selected_kb: bool = True,
        # Session
        history_limit: Optional[int] = None,
        new_session: bool = False,
        attachments: Optional[List[dict]] = None,
        # Subscription
        is_subscription: bool = False,
        system_mcp_config: Optional[dict] = None,
        # Tracing
        trace_context: Optional[dict] = None,
        # Model override (from ChatConfigBuilder)
        override_model_name: Optional[str] = None,
        force_override: bool = False,
        team_member_prompt: Optional[str] = None,
    ) -> ExecutionRequest:
        """Build ExecutionRequest from database models.

        Args:
            subtask: The subtask to execute
            task: The parent task
            user: The user who initiated the task
            team: The team (agent) configuration
            message: The user message/prompt
            enable_tools: Whether to enable tool usage
            enable_web_search: Whether to enable web search
            enable_clarification: Whether to enable clarification mode
            enable_deep_thinking: Whether to enable deep thinking mode
            skill_names: List of skill names to load (deprecated, use preload_skills)
            preload_skills: List of skills to preload into system prompt
            user_selected_skills: List of user-selected skills
            knowledge_base_ids: List of knowledge base IDs
            document_ids: List of document IDs
            is_user_selected_kb: Whether knowledge bases are user-selected
            history_limit: Maximum number of history messages
            new_session: Whether to start a new session
            attachments: List of attachment dictionaries
            is_subscription: Whether this is a subscription task
            system_mcp_config: System MCP configuration
            trace_context: OpenTelemetry trace context
            override_model_name: Optional model name to override bot's model
            force_override: If True, override takes highest priority
            team_member_prompt: Optional additional prompt from team member

        Returns:
            ExecutionRequest ready for dispatch
        """
        # Parse team CRD
        team_crd = Team.model_validate(team.json)

        # Get first bot from team
        bot = self._get_first_bot(team, team_crd)
        if not bot:
            raise ValueError(f"No bot found for team {team.name}")

        # Build user info
        user_info = self._build_user_info(user)

        # Get model config with full resolution (decryption, placeholder replacement)
        model_config = self._get_model_config(
            bot=bot,
            user_id=user.id,
            user_name=user.user_name,
            override_model_name=override_model_name,
            force_override=force_override,
            task_id=task.id,
            team_id=team.id,
        )

        # Get base system prompt from Ghost
        system_prompt = self._get_base_system_prompt(
            bot=bot,
            team=team,
            team_crd=team_crd,
            team_member_prompt=team_member_prompt,
        )

        # Get skills for the bot (full resolution from Ghost)
        # Convert preload_skills to the format expected by _get_bot_skills
        user_preload_skills = None
        if preload_skills:
            user_preload_skills = [
                {"name": s} if isinstance(s, str) else s for s in preload_skills
            ]

        resolved_skills, resolved_preload_skills, resolved_user_selected = (
            self._get_bot_skills(
                bot=bot,
                team=team,
                user_id=user.id,
                user_preload_skills=user_preload_skills,
            )
        )

        # Build bot configuration
        bot_config = self._build_bot_config(
            team,
            team_crd,
            bot,
            user_id=user.id,
            override_model_name=override_model_name,
            force_override=force_override,
        )

        # Build MCP servers configuration
        mcp_servers = self._build_mcp_servers(bot, team)

        # Build workspace configuration
        workspace = self._build_workspace(task)

        # Get collaboration model
        collaboration_model = team_crd.spec.collaborationModel or "single"

        # Determine if group chat
        is_group_chat = self._is_group_chat(task)

        return ExecutionRequest(
            task_id=task.id,
            subtask_id=subtask.id,
            team_id=team.id,
            team_name=team.name,
            team_namespace=team.namespace,
            user=user_info,
            user_id=user.id,
            user_name=user.user_name,
            bot=bot_config,
            model_config=model_config,
            system_prompt=system_prompt,
            prompt=message,
            enable_tools=enable_tools,
            enable_web_search=enable_web_search,
            enable_clarification=enable_clarification,
            enable_deep_thinking=enable_deep_thinking,
            skill_names=[s["name"] for s in resolved_skills],
            skill_configs=resolved_skills,
            preload_skills=resolved_preload_skills,
            user_selected_skills=user_selected_skills or resolved_user_selected,
            mcp_servers=mcp_servers,
            knowledge_base_ids=knowledge_base_ids,
            document_ids=document_ids,
            table_contexts=[],
            is_user_selected_kb=is_user_selected_kb,
            workspace=workspace,
            message_id=subtask.message_id,
            user_message_id=None,
            is_group_chat=is_group_chat,
            history_limit=history_limit,
            new_session=new_session,
            collaboration_model=collaboration_model,
            auth_token=self._get_auth_token(user),
            task_token=self._get_task_token(task),
            backend_url=settings.BACKEND_INTERNAL_URL,
            attachments=attachments or [],
            is_subscription=is_subscription,
            system_mcp_config=system_mcp_config,
            trace_context=trace_context,
            executor_name=subtask.executor_name,
        )

    # =========================================================================
    # Bot Resolution (from ChatConfigBuilder)
    # =========================================================================

    def _get_first_bot(self, team: Kind, team_crd: Team) -> Kind | None:
        """Get the first bot from team members.

        Args:
            team: Team Kind object
            team_crd: Parsed Team CRD

        Returns:
            Bot Kind object or None if not found
        """
        if not team_crd.spec.members:
            logger.error("Team %s has no members", team.name)
            return None

        first_member = team_crd.spec.members[0]

        bot = (
            self.db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
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

    # =========================================================================
    # Model Configuration (from ChatConfigBuilder)
    # =========================================================================

    def _get_model_config(
        self,
        bot: Kind,
        user_id: int,
        user_name: str,
        override_model_name: str | None,
        force_override: bool,
        task_id: int,
        team_id: int,
    ) -> dict[str, Any]:
        """Get model configuration for the bot.

        This method provides full model resolution including:
        - Database lookup for model configuration
        - Environment variable placeholder replacement
        - API key decryption
        - Custom placeholder replacement (user_id, task_id, etc.)

        Args:
            bot: Bot Kind object
            user_id: User ID
            user_name: User name for placeholder replacement
            override_model_name: Optional model name override
            force_override: Whether override takes priority
            task_id: Task ID for placeholder replacement
            team_id: Team ID for placeholder replacement

        Returns:
            Model configuration dictionary
        """
        from app.services.chat.config.model_resolver import (
            _process_model_config_placeholders,
            get_model_config_for_bot,
        )

        # Get base model config (extracts from DB and handles env placeholders + decryption)
        # Use user_id instead of team.user_id to support:
        # 1. Flow tasks where Flow owner may have different models than Team owner
        # 2. User's private models should be accessible based on the current user
        model_config = get_model_config_for_bot(
            self.db,
            bot,
            user_id,
            override_model_name=override_model_name,
            force_override=force_override,
        )

        # Build agent_config and task_data for placeholder replacement
        bot_spec = bot.json.get("spec", {}) if bot.json else {}
        agent_config = bot_spec.get("agent_config", {})
        user_info = {"id": user_id, "name": user_name}
        task_data = {
            "task_id": task_id,
            "team_id": team_id,
            "user": user_info,
        }

        # Process all placeholders in model_config (api_key + default_headers)
        model_config = _process_model_config_placeholders(
            model_config=model_config,
            user_id=user_id,
            user_name=user_name,
            agent_config=agent_config,
            task_data=task_data,
        )

        return model_config

    # =========================================================================
    # System Prompt (from ChatConfigBuilder)
    # =========================================================================

    def _get_base_system_prompt(
        self,
        bot: Kind,
        team: Kind,
        team_crd: Team,
        team_member_prompt: str | None,
    ) -> str:
        """Get base system prompt for the bot (without enhancements).

        This method returns only the base system prompt from Ghost + team member prompt.
        Prompt enhancements (clarification, deep thinking, skills) are handled
        internally by chat_shell based on the enable_* flags.

        Args:
            bot: Bot Kind object
            team: Team Kind object
            team_crd: Parsed Team CRD
            team_member_prompt: Optional additional prompt from team member

        Returns:
            Base system prompt (Ghost prompt + team member prompt)
        """
        from app.services.chat.config.model_resolver import get_bot_system_prompt

        # Get team member prompt from first member if not provided
        if team_member_prompt is None and team_crd.spec.members:
            team_member_prompt = team_crd.spec.members[0].prompt

        # Get base system prompt (no enhancements applied here)
        return get_bot_system_prompt(
            self.db,
            bot,
            team.user_id,
            team_member_prompt,
        )

    # =========================================================================
    # Shell Type Resolution (from ChatConfigBuilder)
    # =========================================================================

    def _resolve_shell_type(self, bot: Kind, user_id: int) -> str:
        """Resolve shell_type from bot's shellRef.

        This method queries the Shell CRD to get the shell_type.
        It's called once per builder instance and the result is cached.

        Args:
            bot: Bot Kind object
            user_id: User ID for shell lookup

        Returns:
            Shell type string (e.g., "Chat", "ClaudeCode", "Agno")
        """
        # Return cached value if available
        if self._cached_shell_type is not None:
            return self._cached_shell_type

        # Default value
        shell_type = "Chat"

        bot_crd = Bot.model_validate(bot.json)

        if not (bot_crd.spec and bot_crd.spec.shellRef):
            self._cached_shell_type = shell_type
            return shell_type

        shell_ref = bot_crd.spec.shellRef

        # Query user's private shell first
        shell = (
            self.db.query(Kind)
            .filter(
                Kind.user_id == user_id,
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
            "[TaskRequestBuilder] Resolved shell_type=%s for bot=%s (shell_ref=%s/%s)",
            shell_type,
            bot_crd.metadata.name if bot_crd.metadata else "unknown",
            shell_ref.namespace,
            shell_ref.name,
        )

        self._cached_shell_type = shell_type
        return shell_type

    # =========================================================================
    # Skill Resolution (from ChatConfigBuilder)
    # =========================================================================

    def _get_bot_skills(
        self,
        bot: Kind,
        team: Kind,
        user_id: int,
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
            team: Team Kind object
            user_id: User ID for skill lookup
            user_preload_skills: Optional list of user-selected skills to preload.
                Each item can be a dict with {name, namespace, is_public} or a SkillRef object.

        Returns:
            Tuple of (skills, preload_skills, user_selected_skills)
        """
        from app.schemas.kind import Skill as SkillCRD

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
                Kind.user_id == team.user_id,
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
        user_selected_skills: list[str] = []
        existing_skill_names: set[str] = set()

        # Build preload set from Ghost CRD
        ghost_preload_set = set(ghost_crd.spec.preload_skills or [])

        # Process Ghost skills
        if ghost_crd.spec.skills:
            for skill_name in ghost_crd.spec.skills:
                skill = self._find_skill(skill_name, team)
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
                skill = self._find_skill_by_ref(
                    skill_name, skill_namespace, is_public, user_id
                )
                if skill:
                    skill_data = self._build_skill_data(skill)
                    skills.append(skill_data)
                    existing_skill_names.add(skill_name)
                    preload_skills.append(skill_name)
                    user_selected_skills.append(skill_name)
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

    def _find_skill(self, skill_name: str, team: Kind) -> Kind | None:
        """Find skill by name.

        Search order:
        1. User's skill in default namespace (personal)
        2. ANY skill in team's namespace (group-level, from any user)
        3. Public skill (user_id=0)

        Args:
            skill_name: Skill name
            team: Team Kind object

        Returns:
            Skill Kind object or None if not found
        """
        # Get team namespace for group-level skill lookup
        team_namespace = team.namespace if team.namespace else "default"

        # 1. User's personal skill (default namespace)
        skill = (
            self.db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
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

    def _find_skill_by_ref(
        self, skill_name: str, namespace: str, is_public: bool, user_id: int
    ) -> Kind | None:
        """Find skill by name, namespace, and public flag.

        This method is used for additional skills from frontend where we have
        explicit namespace and is_public information.

        Search order for non-public skills:
        1. Current user's skill in specified namespace (personal)
        2. ANY user's skill in specified namespace (group-level, for group namespaces)
        3. Current user's skill in default namespace (fallback)

        Args:
            skill_name: Skill name
            namespace: Skill namespace
            is_public: Whether the skill is public (user_id=0)
            user_id: User ID for skill lookup

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
            # 1. Current user's skill in specified namespace
            skill = (
                self.db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Skill",
                    Kind.name == skill_name,
                    Kind.namespace == namespace,
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )
            if skill:
                return skill

            # 2. Group-level skill (any user's skill in the namespace)
            # This allows team members to use skills uploaded by other members
            if namespace != "default":
                skill = (
                    self.db.query(Kind)
                    .filter(
                        Kind.kind == "Skill",
                        Kind.name == skill_name,
                        Kind.namespace == namespace,
                        Kind.is_active == True,  # noqa: E712
                    )
                    .first()
                )
                if skill:
                    return skill

            # 3. Fallback to current user's skill in default namespace
            if namespace != "default":
                return (
                    self.db.query(Kind)
                    .filter(
                        Kind.user_id == user_id,
                        Kind.kind == "Skill",
                        Kind.name == skill_name,
                        Kind.namespace == "default",
                        Kind.is_active == True,  # noqa: E712
                    )
                    .first()
                )
            return None

    def _build_skill_data(self, skill: Kind) -> dict:
        """Build skill data dictionary from a Skill Kind object.

        Args:
            skill: Skill Kind object from database

        Returns:
            Dictionary containing skill metadata for chat configuration
        """
        from app.schemas.kind import Skill as SkillCRD

        skill_crd = SkillCRD.model_validate(skill.json)

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
                base_url = settings.BACKEND_INTERNAL_URL.rstrip("/")
                skill_data["binary_download_url"] = (
                    f"{base_url}/api/internal/skills/{skill.id}/binary"
                )

        return skill_data

    # =========================================================================
    # Bot Configuration Building
    # =========================================================================

    def _build_bot_config(
        self,
        team: Kind,
        team_crd: Team,
        first_bot: Kind,
        user_id: int,
        override_model_name: str | None = None,
        force_override: bool = False,
    ) -> list[dict]:
        """Build bot configuration list.

        Args:
            team: Team Kind object
            team_crd: Parsed Team CRD
            first_bot: First bot Kind object (already resolved)
            user_id: User ID for model resolution
            override_model_name: Optional model name override from task
            force_override: Whether override takes priority

        Returns:
            List of bot configuration dictionaries
        """
        from app.services.chat.config.model_resolver import (
            build_agent_config_for_bot,
        )

        members = team_crd.spec.members or []

        bot_configs = []
        for i, member in enumerate(members):
            # For the first bot, use the already resolved one
            if i == 0:
                bot = first_bot
            else:
                # Query additional bots
                bot = (
                    self.db.query(Kind)
                    .filter(
                        Kind.user_id == team.user_id,
                        Kind.kind == "Bot",
                        Kind.name == member.botRef.name,
                        Kind.namespace == member.botRef.namespace,
                        Kind.is_active,
                    )
                    .first()
                )

            if not bot:
                continue

            bot_crd = Bot.model_validate(bot.json)
            bot_spec = bot_crd.spec

            # Get raw bot JSON for extra fields not in BotSpec schema
            bot_json = bot.json or {}
            bot_spec_json = bot_json.get("spec", {})

            # Get shell_type
            shell_type = self._resolve_shell_type(bot, team.user_id)

            # Get ghost info for system_prompt and skills
            ghost_system_prompt = ""
            ghost_mcp_servers = []
            ghost_skills = []

            if bot_spec and bot_spec.ghostRef:
                ghost = (
                    self.db.query(Kind)
                    .filter(
                        Kind.user_id == team.user_id,
                        Kind.kind == "Ghost",
                        Kind.name == bot_spec.ghostRef.name,
                        Kind.namespace == bot_spec.ghostRef.namespace,
                        Kind.is_active,
                    )
                    .first()
                )
                if ghost and ghost.json:
                    ghost_crd = Ghost.model_validate(ghost.json)
                    ghost_system_prompt = ghost_crd.spec.systemPrompt or ""
                    # Convert dict format to list format with name field
                    mcp_servers_dict = ghost_crd.spec.mcpServers or {}
                    ghost_mcp_servers = [
                        {"name": name, **config}
                        for name, config in mcp_servers_dict.items()
                    ]
                    ghost_skills = ghost_crd.spec.skills or []

            # Resolve agent_config from model binding
            agent_config = build_agent_config_for_bot(
                self.db,
                bot,
                user_id,
                override_model_name=override_model_name,
                force_override=force_override,
            )

            bot_config = {
                "id": bot.id,
                "name": bot.name,
                "shell_type": shell_type,
                "agent_config": agent_config,
                "system_prompt": ghost_system_prompt,
                "mcp_servers": ghost_mcp_servers,
                "skills": ghost_skills,
                "role": member.role or "worker",
                "base_image": bot_spec_json.get("baseImage"),
            }
            bot_configs.append(bot_config)

        # If no members, create default bot config
        if not bot_configs:
            bot_configs.append(
                {
                    "id": None,
                    "name": team.name,
                    "shell_type": "Chat",
                    "agent_config": {},
                    "system_prompt": "",
                    "mcp_servers": [],
                    "skills": [],
                    "role": "worker",
                    "base_image": None,
                }
            )

        return bot_configs

    # =========================================================================
    # MCP Servers Configuration
    # =========================================================================

    def _build_mcp_servers(self, bot: Kind, team: Kind) -> list[dict]:
        """Build MCP servers configuration.

        Args:
            bot: Bot Kind object
            team: Team Kind object

        Returns:
            List of MCP server configuration dictionaries
        """
        bot_crd = Bot.model_validate(bot.json)

        if not bot_crd.spec or not bot_crd.spec.ghostRef:
            return []

        # Query Ghost
        ghost = (
            self.db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Ghost",
                Kind.name == bot_crd.spec.ghostRef.name,
                Kind.namespace == bot_crd.spec.ghostRef.namespace,
                Kind.is_active,
            )
            .first()
        )

        if not ghost or not ghost.json:
            return []

        ghost_crd = Ghost.model_validate(ghost.json)
        mcp_servers_dict = ghost_crd.spec.mcpServers or {}
        # Convert dict format to list format with name field
        return [{"name": name, **config} for name, config in mcp_servers_dict.items()]

    # =========================================================================
    # Helper Methods
    # =========================================================================

    def _build_user_info(self, user: User) -> dict:
        """Build user info dictionary.

        Args:
            user: User model instance

        Returns:
            User info dictionary
        """
        return {
            "id": user.id,
            "name": user.user_name,
            "git_domain": getattr(user, "git_domain", None),
            "git_token": getattr(user, "git_token", None),
            "git_id": getattr(user, "git_id", None),
            "git_login": getattr(user, "git_login", None),
            "git_email": getattr(user, "git_email", None),
        }

    def _build_workspace(self, task: TaskResource) -> dict:
        """Build workspace configuration.

        Args:
            task: Task resource model instance

        Returns:
            Workspace configuration dictionary
        """
        task_json = task.json or {}
        task_spec = task_json.get("spec", {})
        workspace_ref = task_spec.get("workspaceRef", {})

        return {
            "repository": workspace_ref.get("repository", {}),
            "branch": workspace_ref.get("branch"),
            "path": workspace_ref.get("path"),
        }

    def _is_group_chat(self, task: TaskResource) -> bool:
        """Determine if task is a group chat.

        Args:
            task: Task resource model instance

        Returns:
            True if task is a group chat
        """
        task_json = task.json or {}
        task_spec = task_json.get("spec", {})
        return task_spec.get("isGroupChat", False) or task_spec.get(
            "is_group_chat", False
        )

    def _get_auth_token(self, user: User) -> str:
        """Get authentication token for user.

        Args:
            user: User model instance

        Returns:
            Authentication token string
        """
        # TODO: Generate or retrieve auth token
        return ""

    def _get_task_token(self, task: TaskResource) -> str:
        """Get task token.

        Args:
            task: Task resource model instance

        Returns:
            Task token string
        """
        return getattr(task, "token", "") or ""
