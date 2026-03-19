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
import urllib.request
from typing import Any, List, Optional, Union

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.schemas.kind import Bot, Ghost, Shell, Team
from app.services.mcp_provider_registry import list_mcp_providers
from app.services.user_mcp_service import user_mcp_service
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
        message: Union[str, list],
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
        previous_bot_id: Optional[int] = None,
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

        # Get bot for this subtask
        # In pipeline mode, subtask.bot_ids contains the specific bot for this stage
        # Otherwise, use the first bot from team members
        bot = self._get_bot_for_subtask(subtask, team, team_crd)
        if not bot:
            raise ValueError(f"No bot found for team {team.name}")

        # Build workspace configuration first to get git_domain for user info matching
        workspace = self._build_workspace(task)

        # Extract git fields from workspace for executor compatibility
        # Executor's download_code() expects top-level git_url, branch_name, etc.
        git_url = None
        git_domain = None
        git_repo = None
        git_repo_id = None
        branch_name = None
        if workspace and workspace.get("repository"):
            repo = workspace["repository"]
            git_url = repo.get("gitUrl")
            git_domain = repo.get("gitDomain")
            git_repo = repo.get("gitRepo")
            git_repo_id = repo.get("gitRepoId")
            branch_name = repo.get("branchName") or workspace.get("branch")

        # Build user info with git_domain to match correct git account
        user_info = self._build_user_info(user, git_domain)

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
        effective_preload_skills = list(preload_skills or [])
        effective_preload_skills = self._inject_conditional_provider_skills(
            user=user,
            message=message,
            preload_skills=effective_preload_skills,
        )

        user_preload_skills = None
        if effective_preload_skills:
            user_preload_skills = [
                {"name": s} if isinstance(s, str) else s
                for s in effective_preload_skills
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

        user_mcp_servers = self._load_user_mcp_servers(user)
        if bot_config and user_mcp_servers:
            self._merge_user_mcp_into_bot_config(bot_config, user_mcp_servers)

        # Merge user-selected skills into bot_config so Executor downloads them
        if bot_config and resolved_skills:
            all_skill_names = [s["name"] for s in resolved_skills]
            existing_skills = set(bot_config[0].get("skills", []))
            for name in all_skill_names:
                if name not in existing_skills:
                    bot_config[0].setdefault("skills", []).append(name)
                    existing_skills.add(name)

        # For ClaudeCode executor: merge skill MCP, normalize types, filter unreachable
        if bot_config:
            shell_type = bot_config[0].get("shell_type", "")
            if shell_type == "ClaudeCode":
                self._prepare_mcp_for_claude_code(bot_config[0], resolved_skills)

        # Generate auth token first (needed for MCP server authentication)
        auth_token = self._generate_auth_token(task, subtask, user)

        # Build MCP servers configuration (with auto-injection for subscription tasks)
        mcp_servers = self._build_mcp_servers(
            bot,
            team,
            user=user,
            is_subscription=is_subscription,
            auth_token=auth_token,
        )

        # Get collaboration model
        collaboration_model = team_crd.spec.collaborationModel or "solo"

        # Determine if group chat
        is_group_chat = self._is_group_chat(task)

        # Auto-determine new_session for pipeline mode
        # In pipeline mode, new_session should be True when stage changes (different bot)
        # This ensures each pipeline stage has independent context
        if collaboration_model == "pipeline" and previous_bot_id is not None:
            current_bot_id = bot.id if bot else None
            if previous_bot_id != current_bot_id:
                new_session = True
                logger.info(
                    "[TaskRequestBuilder] Pipeline: stage changed "
                    "(previous_bot_id=%s, current_bot_id=%s), using new session",
                    previous_bot_id,
                    current_bot_id,
                )

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
            # Git fields extracted from workspace for executor compatibility
            git_url=git_url,
            git_domain=git_domain,
            git_repo=git_repo,
            git_repo_id=git_repo_id,
            branch_name=branch_name,
            message_id=subtask.message_id,
            user_message_id=None,
            is_group_chat=is_group_chat,
            history_limit=history_limit,
            new_session=new_session,
            collaboration_model=collaboration_model,
            auth_token=auth_token,
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

    def _get_bot_for_subtask(
        self, subtask: Subtask, team: Kind, team_crd: Team
    ) -> Kind | None:
        """Get the bot for a specific subtask.

        In pipeline mode, subtask.bot_ids contains the specific bot for this stage.
        This method first tries to use the bot from subtask.bot_ids, then falls back
        to the first bot from team members.

        Args:
            subtask: The subtask to get bot for
            team: Team Kind object
            team_crd: Parsed Team CRD

        Returns:
            Bot Kind object or None if not found
        """
        # First, try to get bot from subtask.bot_ids (for pipeline mode)
        if subtask.bot_ids:
            bot_id = subtask.bot_ids[0]
            bot = (
                self.db.query(Kind)
                .filter(
                    Kind.id == bot_id,
                    Kind.kind == "Bot",
                    Kind.is_active,
                )
                .first()
            )
            if bot:
                logger.info(
                    "[TaskRequestBuilder] Using bot from subtask.bot_ids: "
                    "bot_id=%d, bot_name=%s",
                    bot_id,
                    bot.name,
                )
                return bot
            else:
                logger.warning(
                    "[TaskRequestBuilder] Bot not found for subtask.bot_ids[0]=%d, "
                    "falling back to first team member",
                    bot_id,
                )

        # Fallback to first bot from team members
        return self._get_first_bot(team, team_crd)

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
        - Secondary model config for video models

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
        task_data = ExecutionRequest(
            task_id=task_id,
            team_id=team_id,
            user=user_info,
        )

        # Process all placeholders in model_config (api_key + default_headers)
        model_config = _process_model_config_placeholders(
            model_config=model_config,
            user_id=user_id,
            user_name=user_name,
            agent_config=agent_config,
            task_data=task_data,
        )

        # Handle secondaryModelRef for generation models (video and image).
        # When modelType is 'video' or 'image', resolve secondary model for intent analysis
        # used in multi-turn follow-up generation.
        if model_config.get("modelType") in ("video", "image"):
            secondary_model_config = self._get_secondary_model_config(
                bot=bot,
                user_id=user_id,
                user_name=user_name,
                task_id=task_id,
                team_id=team_id,
            )
            if secondary_model_config:
                model_config["secondary_model_config"] = secondary_model_config

        return model_config

    def _get_secondary_model_config(
        self,
        bot: Kind,
        user_id: int,
        user_name: str,
        task_id: int,
        team_id: int,
    ) -> dict[str, Any] | None:
        """Get secondary model configuration from bot's secondaryModelRef.

        Used for auxiliary tasks like intent analysis in video/image generation
        follow-up conversations.

        Args:
            bot: Bot Kind object
            user_id: User ID
            user_name: User name for placeholder replacement
            task_id: Task ID for placeholder replacement
            team_id: Team ID for placeholder replacement

        Returns:
            Secondary model configuration dictionary or None if not configured
        """
        from app.services.chat.config.model_resolver import (
            _extract_model_config,
            _find_model_with_namespace,
            _process_model_config_placeholders,
        )

        bot_crd = Bot.model_validate(bot.json)

        if not bot_crd.spec or not bot_crd.spec.secondaryModelRef:
            logger.debug(
                "[TaskRequestBuilder] No secondaryModelRef configured for bot=%s",
                bot.name,
            )
            return None

        secondary_model_ref = bot_crd.spec.secondaryModelRef
        model_name = secondary_model_ref.name

        # Find the secondary model
        model_kind, model_spec = _find_model_with_namespace(
            self.db, model_name, user_id
        )

        if not model_spec:
            logger.warning(
                "[TaskRequestBuilder] Secondary model not found: name=%s",
                model_name,
            )
            return None

        # Extract and process model config
        secondary_config = _extract_model_config(model_spec)

        # Process placeholders
        bot_spec = bot.json.get("spec", {}) if bot.json else {}
        agent_config = bot_spec.get("agent_config", {})
        user_info = {"id": user_id, "name": user_name}
        task_data = ExecutionRequest(
            task_id=task_id,
            team_id=team_id,
            user=user_info,
        )

        secondary_config = _process_model_config_placeholders(
            model_config=secondary_config,
            user_id=user_id,
            user_name=user_name,
            agent_config=agent_config,
            task_data=task_data,
        )

        logger.info(
            "[TaskRequestBuilder] Resolved secondaryModelRef: model=%s",
            model_name,
        )

        return secondary_config

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

        # Get team member prompt from matching member if not provided
        # In pipeline mode, each bot has its own member with a specific prompt
        if team_member_prompt is None and team_crd.spec.members:
            # Find the member that matches the current bot
            for member in team_crd.spec.members:
                if (
                    member.botRef.name == bot.name
                    and member.botRef.namespace == bot.namespace
                ):
                    team_member_prompt = member.prompt
                    logger.debug(
                        "[TaskRequestBuilder] Found matching member prompt for bot=%s: %s",
                        bot.name,
                        team_member_prompt[:50] if team_member_prompt else None,
                    )
                    break
            # Fallback to first member if no match found (for backward compatibility)
            if team_member_prompt is None:
                team_member_prompt = team_crd.spec.members[0].prompt
                logger.debug(
                    "[TaskRequestBuilder] No matching member found for bot=%s, "
                    "using first member prompt",
                    bot.name,
                )

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

        Search order:
        1. User's private shell (user_id == user_id, namespace == shell_ref.namespace)
        2. Group shell (any user_id, namespace == shell_ref.namespace) - for group scenarios
        3. Public shell (user_id == 0)

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

        # 1. Query user's private shell first
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

        # 2. If not found, try group shell (any user's shell in the namespace)
        # This handles the case where shell belongs to another group member
        if not shell and shell_ref.namespace != "default":
            shell = (
                self.db.query(Kind)
                .filter(
                    Kind.kind == "Shell",
                    Kind.name == shell_ref.name,
                    Kind.namespace == shell_ref.namespace,
                    Kind.is_active,
                )
                .first()
            )

        # 3. If still not found, try public shells (user_id = 0)
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

            # Get team namespace for fallback skill lookup
            team_namespace = team.namespace if team.namespace else "default"

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

                # Find and add new skill (with team_namespace fallback)
                skill = self._find_skill_by_ref(
                    skill_name,
                    skill_namespace,
                    is_public,
                    user_id,
                    team_namespace=team_namespace,
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
                        "[_get_bot_skills] User-selected skill not found: name=%s, namespace=%s, is_public=%s, team_namespace=%s",
                        skill_name,
                        skill_namespace,
                        is_public,
                        team_namespace,
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
        self,
        skill_name: str,
        namespace: str,
        is_public: bool,
        user_id: int,
        team_namespace: str | None = None,
    ) -> Kind | None:
        """Find skill by name, namespace, and public flag.

        This method is used for additional skills from frontend where we have
        explicit namespace and is_public information.

        Search order for non-public skills:
        1. Current user's skill in specified namespace (personal)
        2. ANY user's skill in specified namespace (group-level, for group namespaces)
        3. ANY user's skill in team namespace (if different from specified namespace)
        4. Current user's skill in default namespace (fallback)

        Args:
            skill_name: Skill name
            namespace: Skill namespace
            is_public: Whether the skill is public (user_id=0)
            user_id: User ID for skill lookup
            team_namespace: Optional team namespace to search (for group-level skills)

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

            # 3. Team namespace skill (if different from specified namespace)
            # This handles the case where preload_skills only contains name
            # without namespace, but the skill exists in the team's namespace
            if (
                team_namespace
                and team_namespace != "default"
                and team_namespace != namespace
            ):
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
                    logger.info(
                        "[_find_skill_by_ref] Found skill '%s' in team namespace '%s'",
                        skill_name,
                        team_namespace,
                    )
                    return skill

            # 4. Fallback to current user's skill in default namespace
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

    def _load_system_mcp_servers(self) -> list[dict]:
        """Load system-level MCP servers from CHAT_MCP_SERVERS setting.

        Returns:
            List of MCP server configurations in the format:
            [{"name": "server_name", "url": "...", "type": "...", "auth": {...}}]
        """
        import json

        mcp_servers_config = getattr(settings, "CHAT_MCP_SERVERS", "")
        if not mcp_servers_config or mcp_servers_config == "{}":
            return []

        try:
            config_data = json.loads(mcp_servers_config)
            # Support both {"mcpServers": {...}} and direct {...} format
            servers_dict = config_data.get("mcpServers", config_data)

            # Convert dict format to list format
            servers_list = []
            for server_name, server_config in servers_dict.items():
                if isinstance(server_config, dict):
                    server_entry = {
                        "name": server_name,
                        "url": server_config.get("url", ""),
                        "type": server_config.get(
                            "type",
                            server_config.get("transport", "streamable-http"),
                        ),
                    }
                    # Convert "headers" to "auth" for chat_shell compatibility
                    if "headers" in server_config:
                        server_entry["auth"] = server_config["headers"]
                    servers_list.append(server_entry)

            if servers_list:
                logger.info(
                    "[TaskRequestBuilder] Loaded %d system MCP servers from CHAT_MCP_SERVERS: %s",
                    len(servers_list),
                    [s["name"] for s in servers_list],
                )
            return servers_list

        except json.JSONDecodeError as e:
            logger.warning(
                "[TaskRequestBuilder] Failed to parse CHAT_MCP_SERVERS: %s", str(e)
            )
            return []

    def _build_mcp_servers(
        self,
        bot: Kind,
        team: Kind,
        *,
        user: User,
        is_subscription: bool = False,
        auth_token: str = "",
    ) -> list[dict]:
        """Build MCP servers configuration.

        Merges MCP servers from multiple sources:
        1. System-level MCP servers (from CHAT_MCP_SERVERS setting)
        2. Bot-level MCP servers (from Ghost CRD mcpServers config)
        3. Auto-injected System MCP (for subscription tasks)

        Bot-level servers take precedence over system-level servers
        when there are name conflicts.

        Ghost CRD format (dict):
            {"server_name": {"url": "...", "type": "...", "headers": {...}}}

        Output format (list):
            [{"name": "server_name", "url": "...", "type": "...", "auth": {...}}]

        Args:
            bot: Bot Kind object
            team: Team Kind object
            is_subscription: Whether this is a subscription task
            auth_token: Authentication token for MCP server

        Returns:
            List of MCP server configuration dictionaries
        """
        # Load system-level MCP servers first
        system_mcp_servers = self._load_system_mcp_servers()

        # Auto-inject System MCP for subscription tasks (provides silent_exit tool)
        if is_subscription and auth_token:
            system_mcp_config = self._get_auto_injected_system_mcp(auth_token)
            if system_mcp_config:
                system_mcp_servers.extend(system_mcp_config)
                logger.info(
                    "[TaskRequestBuilder] Auto-injected System MCP for subscription task"
                )

        # Load bot-level MCP servers from Ghost CRD
        bot_mcp_servers = []
        bot_crd = Bot.model_validate(bot.json)

        if bot_crd.spec and bot_crd.spec.ghostRef:
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

            if ghost and ghost.json:
                ghost_crd = Ghost.model_validate(ghost.json)
                mcp_servers_dict = ghost_crd.spec.mcpServers

                if mcp_servers_dict:
                    # Convert dict format to list format for chat_shell compatibility
                    for server_name, server_config in mcp_servers_dict.items():
                        if isinstance(server_config, dict):
                            server_entry = {
                                "name": server_name,
                                "url": server_config.get("url", ""),
                                "type": server_config.get("type", "streamable-http"),
                            }
                            # Convert "headers" to "auth" for chat_shell compatibility
                            if "headers" in server_config:
                                server_entry["auth"] = server_config["headers"]
                            # Include stdio-specific fields (command, args, env)
                            if "command" in server_config:
                                server_entry["command"] = server_config["command"]
                            if "args" in server_config:
                                server_entry["args"] = server_config["args"]
                            if "env" in server_config:
                                server_entry["env"] = server_config["env"]
                            bot_mcp_servers.append(server_entry)

        user_mcp_servers = self._load_user_mcp_servers(user)

        # Merge system, user, and bot MCP servers (bot takes precedence)
        # Build a dict to deduplicate by server name
        servers_by_name = {}
        for server in system_mcp_servers:
            server_name = server.get("name", "server")
            servers_by_name[server_name] = server
        for server in user_mcp_servers:
            server_name = server.get("name", "server")
            servers_by_name[server_name] = server
        for server in bot_mcp_servers:
            server_name = server.get("name", "server")
            servers_by_name[server_name] = server

        merged_servers = list(servers_by_name.values())

        if merged_servers:
            logger.info(
                "[TaskRequestBuilder] Built %d MCP servers (system=%d, user=%d, bot=%d): %s",
                len(merged_servers),
                len(system_mcp_servers),
                len(user_mcp_servers),
                len(bot_mcp_servers),
                [s["name"] for s in merged_servers],
            )

        return merged_servers

    @staticmethod
    def _load_user_mcp_servers(user: User) -> list[dict[str, Any]]:
        """Load user-scoped MCP servers from preferences."""
        return user_mcp_service.list_mcp_servers(user.preferences)

    @staticmethod
    def _extract_prompt_text(message: Union[str, list]) -> str:
        """Extract plain text from a prompt payload."""
        if isinstance(message, str):
            return message

        if not isinstance(message, list):
            return ""

        text_parts: list[str] = []
        for item in message:
            if not isinstance(item, dict):
                continue
            if item.get("type") in {"input_text", "text"}:
                text = item.get("text")
                if isinstance(text, str) and text:
                    text_parts.append(text)

        return "\n".join(text_parts)

    def _inject_conditional_provider_skills(
        self,
        *,
        user: User,
        message: Union[str, list],
        preload_skills: list,
    ) -> list:
        """Preload provider config guidance skills when relevant and needed."""
        merged_preload_skills = list(preload_skills)
        prompt_text = self._extract_prompt_text(message).strip().lower()
        if not prompt_text:
            return merged_preload_skills

        existing_names = {
            skill if isinstance(skill, str) else skill.get("name")
            for skill in merged_preload_skills
            if isinstance(skill, (str, dict))
        }

        for provider in list_mcp_providers():
            keywords = provider.get("message_keywords") or ()
            if not keywords or not any(keyword in prompt_text for keyword in keywords):
                continue

            service_configs = user_mcp_service.list_provider_service_configs(
                user.preferences, provider["provider_id"]
            )
            all_services_ready = all(
                service.get("enabled") and (service.get("url") or "").strip()
                for service in service_configs
            )
            if all_services_ready:
                continue

            guidance_skill = provider.get("guidance_skill")
            if guidance_skill and guidance_skill not in existing_names:
                merged_preload_skills.append(
                    {
                        "name": guidance_skill,
                        "namespace": "default",
                        "is_public": True,
                    }
                )
                existing_names.add(guidance_skill)

        return merged_preload_skills

    @staticmethod
    def _merge_user_mcp_into_bot_config(
        bot_config_list: list[dict[str, Any]], user_mcp_servers: list[dict[str, Any]]
    ) -> None:
        """Inject user-scoped MCP servers into executor bot configs."""
        if not user_mcp_servers:
            return

        supported_shell_types = {"ClaudeCode", "Agno"}
        for bot_config in bot_config_list:
            if bot_config.get("shell_type") not in supported_shell_types:
                continue

            merged_servers = {
                server.get("name", "server"): server
                for server in (bot_config.get("mcp_servers") or [])
                if isinstance(server, dict)
            }
            for server in user_mcp_servers:
                merged_servers[server.get("name", "server")] = dict(server)

            bot_config["mcp_servers"] = list(merged_servers.values())

    # =========================================================================
    # Claude Code MCP Processing
    # =========================================================================

    def _prepare_mcp_for_claude_code(
        self, bot_config: dict, skill_configs: list
    ) -> None:
        """Prepare MCP servers for Claude Code executor.

        For ClaudeCode shell type, this method:
        1. Extracts skill MCP servers and merges into bot mcp_servers
        2. Normalizes types (streamable-http -> http) for Claude Code SDK
        3. Filters out unreachable servers to prevent SDK initialization timeout

        Modifies bot_config in-place.

        Args:
            bot_config: Single bot configuration dict (modified in-place)
            skill_configs: List of resolved skill config dicts
        """
        # Step 1: Extract skill MCP servers and merge
        skill_mcp = self._extract_skill_mcp_to_list(skill_configs)
        if skill_mcp:
            bot_config.setdefault("mcp_servers", []).extend(skill_mcp)
            logger.info(
                "[MCP-CLAUDE] Merged %d skill MCP server(s): %s",
                len(skill_mcp),
                [s.get("name", "?") for s in skill_mcp],
            )

        mcp_list = bot_config.get("mcp_servers", [])
        if not mcp_list:
            return

        # Step 2: Normalize types (streamable-http -> http)
        self._normalize_mcp_types_for_claude_code(mcp_list)

        # Step 3: Filter out unreachable servers
        bot_config["mcp_servers"] = self._filter_reachable_mcp_servers(mcp_list)
        if not bot_config["mcp_servers"]:
            logger.warning("[MCP-CLAUDE] All MCP servers unreachable, removed")

    @staticmethod
    def _extract_skill_mcp_to_list(skill_configs: list) -> list:
        """Extract MCP servers from skill configs in list format.

        Each skill may declare mcpServers in dict format. This converts them
        to list format with prefixed names to avoid cross-skill conflicts.

        Args:
            skill_configs: List of resolved skill config dicts

        Returns:
            List of MCP server dicts in list format:
            [{"name": "skillName_serverName", "type": "...", "url": "...", ...}]
        """
        if not skill_configs:
            return []

        result: list[dict] = []
        for skill_config in skill_configs:
            skill_name = skill_config.get("name", "unknown")
            mcp_servers = skill_config.get("mcpServers")
            if not mcp_servers or not isinstance(mcp_servers, dict):
                continue

            for server_name, server_config in mcp_servers.items():
                if not isinstance(server_config, dict):
                    continue
                entry = {
                    "name": f"{skill_name}_{server_name}",
                    **server_config,
                }
                result.append(entry)
                logger.info(
                    "[SKILL-MCP] Extracted: %s -> type=%s, url=%s",
                    entry["name"],
                    server_config.get("type", "?"),
                    server_config.get("url", "?"),
                )

        return result

    @staticmethod
    def _normalize_mcp_types_for_claude_code(mcp_servers: list) -> None:
        """Normalize MCP server types for Claude Code SDK compatibility.

        Claude Code SDK supports "http" but skill/ghost configs use
        "streamable-http". Converts in-place.

        Args:
            mcp_servers: List of MCP server config dicts (modified in-place)
        """
        TYPE_MAPPING = {"streamable-http": "http"}

        for server in mcp_servers:
            if not isinstance(server, dict):
                continue
            original_type = server.get("type", "")
            mapped = TYPE_MAPPING.get(original_type)
            if mapped:
                server["type"] = mapped
                logger.info(
                    "[MCP-NORMALIZE] '%s': type '%s' -> '%s'",
                    server.get("name", "?"),
                    original_type,
                    mapped,
                )

    @staticmethod
    def _check_mcp_server_reachable(server: dict) -> bool:
        """Check if an MCP server URL is reachable with a short timeout.

        Sends a GET request (not HEAD, as some servers like SSE endpoints
        don't support HEAD method and will timeout). Any HTTP response
        (including 4xx/5xx) means the server is reachable. Only connection
        failures are treated as unreachable.

        Args:
            server: Server config dict with 'url' and optional 'headers'

        Returns:
            True if server responded or is stdio type, False on connection failure
        """
        server_type = server.get("type", "").lower()

        # Skip reachability check for stdio servers (they run locally via command)
        if server_type == "stdio":
            return True

        url = server.get("url", "")
        if not url:
            return False

        # URLs pointing to our own backend are always reachable.
        # Checking them with a synchronous HTTP request would deadlock
        # (single-worker uvicorn can't serve the request while blocked).
        if "${{backend_url}}" in url:
            return True

        try:
            # Use GET instead of HEAD because some servers (especially SSE endpoints)
            # don't support HEAD method and will timeout
            req = urllib.request.Request(url, method="GET")
            # Add headers, skipping unresolved placeholders
            headers = server.get("headers", server.get("auth", {}))
            if isinstance(headers, dict):
                for k, v in headers.items():
                    if isinstance(v, str) and not v.startswith("${{"):
                        req.add_header(k, v)
            urllib.request.urlopen(req, timeout=5)
            return True
        except urllib.error.HTTPError:
            # Any HTTP response (including 4xx/5xx) means the server is reachable
            return True
        except Exception as e:
            logger.warning(
                "[MCP-CHECK] Failed to check server reachability: url=%s, error=%s",
                url,
                str(e),
            )
            return False

    def _filter_reachable_mcp_servers(self, mcp_servers: list) -> list:
        """Filter out unreachable MCP servers.

        Args:
            mcp_servers: List of MCP server config dicts

        Returns:
            List containing only reachable MCP servers
        """
        if not mcp_servers:
            return mcp_servers

        reachable = []
        unreachable_names: list[str] = []

        for server in mcp_servers:
            name = server.get("name", "?")
            if self._check_mcp_server_reachable(server):
                reachable.append(server)
                logger.info("[MCP-CHECK] '%s' is reachable", name)
            else:
                unreachable_names.append(name)
                logger.warning(
                    "[MCP-CHECK] '%s' is NOT reachable: %s",
                    name,
                    server.get("url", "?"),
                )

        if unreachable_names:
            logger.warning(
                "[MCP-FILTER] Removed %d unreachable server(s): %s",
                len(unreachable_names),
                unreachable_names,
            )

        return reachable

    def _get_auto_injected_system_mcp(self, auth_token: str) -> list[dict]:
        """Get auto-injected System MCP configuration for subscription tasks.

        The System MCP provides the silent_exit tool which allows AI to silently
        terminate execution when results don't require user attention.

        Args:
            auth_token: Authentication token for MCP server

        Returns:
            List of MCP server configurations in list format:
            [{"name": "wegent-system", "url": "...", "type": "...", "auth": {...}}]
        """
        from app.mcp_server.server import get_mcp_system_config

        backend_url = settings.BACKEND_INTERNAL_URL.rstrip("/")

        # get_mcp_system_config returns dict format: {"wegent-system": {...}}
        # Convert to list format for _build_mcp_servers compatibility
        system_config = get_mcp_system_config(backend_url, auth_token)

        result = []
        for server_name, server_config in system_config.items():
            server_entry = {
                "name": server_name,
                "url": server_config.get("url", ""),
                "type": server_config.get("type", "streamable-http"),
            }
            # Convert "headers" to "auth" for chat_shell compatibility
            if "headers" in server_config:
                server_entry["auth"] = server_config["headers"]
            result.append(server_entry)

        logger.debug(
            "[TaskRequestBuilder] Generated System MCP config: %s",
            [s["name"] for s in result],
        )

        return result

    # =========================================================================
    # Helper Methods
    # =========================================================================

    def _build_user_info(self, user: User, git_domain: str | None = None) -> dict:
        """Build user info dictionary.

        Git-related fields are stored in user.git_info JSON field as a list of git accounts.
        Each account has: type, git_domain, git_token, git_id, git_login, git_email.

        Args:
            user: User model instance
            git_domain: Optional git domain to match (e.g., "github.com")

        Returns:
            User info dictionary with matched git account info
        """
        user_info = {
            "id": user.id,
            "name": user.user_name,
            "git_domain": None,
            "git_token": None,
            "git_id": None,
            "git_login": None,
            "git_email": None,
        }

        # git_info is a list of git account configurations
        git_info_list = user.git_info or []
        if not isinstance(git_info_list, list):
            # Handle edge case where git_info might be a dict (legacy)
            git_info_list = [git_info_list] if git_info_list else []

        if not git_info_list:
            return user_info

        # Find matching git_info entry by domain
        matched_git_info = None
        if git_domain:
            for git_info in git_info_list:
                if git_info.get("git_domain") == git_domain:
                    matched_git_info = git_info
                    break

        # Fallback to first entry if no domain match
        if not matched_git_info and git_info_list:
            matched_git_info = git_info_list[0]

        if matched_git_info:
            user_info["git_domain"] = matched_git_info.get("git_domain")
            user_info["git_token"] = matched_git_info.get("git_token")
            user_info["git_id"] = matched_git_info.get("git_id")
            user_info["git_login"] = matched_git_info.get("git_login")
            user_info["git_email"] = matched_git_info.get("git_email")

        return user_info

    def _build_workspace(self, task: TaskResource) -> dict:
        """Build workspace configuration.

        Queries the Workspace resource to get actual repository information.

        Args:
            task: Task resource model instance

        Returns:
            Workspace configuration dictionary with repository info
        """
        from app.schemas.kind import Task as TaskCRD
        from app.schemas.kind import Workspace

        task_json = task.json or {}

        # Default empty workspace
        workspace_data = {
            "repository": {},
            "branch": None,
            "path": None,
        }

        try:
            task_crd = TaskCRD.model_validate(task_json)

            if not task_crd.spec.workspaceRef:
                return workspace_data

            workspace_ref = task_crd.spec.workspaceRef

            # Query the actual Workspace resource to get repository info
            workspace = (
                self.db.query(TaskResource)
                .filter(
                    TaskResource.user_id == task.user_id,
                    TaskResource.kind == "Workspace",
                    TaskResource.name == workspace_ref.name,
                    TaskResource.namespace == workspace_ref.namespace,
                    TaskResource.is_active == TaskResource.STATE_ACTIVE,
                )
                .first()
            )

            if workspace and workspace.json:
                workspace_crd = Workspace.model_validate(workspace.json)
                repo = workspace_crd.spec.repository

                workspace_data = {
                    "repository": {
                        "gitUrl": repo.gitUrl,
                        "gitRepo": repo.gitRepo,
                        "gitRepoId": repo.gitRepoId,
                        "gitDomain": repo.gitDomain,
                        "branchName": repo.branchName,
                    },
                    "branch": repo.branchName,
                    "path": None,
                }

                logger.debug(
                    "[TaskRequestBuilder] Built workspace: git_repo=%s, branch=%s",
                    repo.gitRepo,
                    repo.branchName,
                )

        except Exception as e:
            logger.warning("[TaskRequestBuilder] Failed to build workspace: %s", str(e))

        return workspace_data

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

    def _generate_auth_token(
        self, task: TaskResource, subtask: Subtask, user: User
    ) -> str:
        """Generate authentication token for task execution.

        Creates a JWT token containing task_id, subtask_id, user_id, and user_name.
        This token is used by executor to authenticate requests to backend APIs
        (e.g., skill downloads, attachment uploads).

        Args:
            task: Task resource model instance
            subtask: Subtask model instance
            user: User model instance

        Returns:
            JWT authentication token string
        """
        from app.services.auth import create_task_token

        return create_task_token(
            task_id=task.id,
            subtask_id=subtask.id,
            user_id=user.id,
            user_name=user.user_name,
        )
