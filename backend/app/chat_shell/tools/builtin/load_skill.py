# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load skill tool for on-demand skill prompt expansion.

This tool implements session-level skill expansion caching:
- Within a single user-AI conversation turn, a skill only needs to be expanded once
- Subsequent calls to the same skill in the same turn return a confirmation message
- When the AI finishes responding to the user, the expansion state is cleared
- The next user message starts a fresh conversation turn

Additionally, this tool handles dynamic provider loading:
- When a skill is loaded, its provider (if defined) is loaded from the skill ZIP package
- Providers are cached in the SkillToolRegistry for reuse
"""

import logging
from typing import Set

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr
from sqlalchemy.orm import Session

from app.chat_shell.skills import SkillToolRegistry
from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.schemas.kind import Skill

logger = logging.getLogger(__name__)


class LoadSkillInput(BaseModel):
    """Input schema for load_skill tool."""

    skill_name: str = Field(description="The name of the skill to load")


class LoadSkillTool(BaseTool):
    """Tool to load a skill and get its full prompt content.

    This tool enables on-demand skill expansion - instead of including
    all skill prompts in the system prompt, skills are loaded only
    when needed, keeping the context window efficient.

    Session-level caching:
    - Skills are cached within a single conversation turn (one user message -> AI response)
    - First call returns the full prompt, subsequent calls return a short confirmation
    - This prevents redundant prompt expansion during multi-tool-call cycles
    - Cache is automatically fresh for each new tool instance (new conversation turn)
    """

    name: str = "load_skill"
    display_name: str = "加载技能"
    description: str = (
        "Load a skill's full instructions when you need specialized guidance. "
        "Call this tool when your task matches one of the available skills' descriptions. "
        "The skill will provide detailed instructions, examples, and best practices. "
        "Note: Within the same response, if you've already loaded a skill, calling it again "
        "will confirm it's still active without repeating the full instructions."
    )
    args_schema: type[BaseModel] = LoadSkillInput

    # Configuration - these are set when creating the tool instance
    db: Session
    user_id: int
    skill_names: list[str]  # Available skill names for this session

    # Private instance attribute for session-level cache (not shared between instances)
    # This tracks which skills have been expanded in the current conversation turn
    _expanded_skills: Set[str] = PrivateAttr(default_factory=set)

    # Store the actual skill prompts that have been loaded (for system prompt injection)
    _loaded_skill_prompts: dict[str, str] = PrivateAttr(default_factory=dict)

    # Cache for skill display names (skill_name -> displayName)
    _skill_display_names: dict[str, str] = PrivateAttr(default_factory=dict)

    class Config:
        arbitrary_types_allowed = True

    def __init__(self, **data):
        """Initialize with a fresh expanded_skills cache."""
        super().__init__(**data)
        self._expanded_skills = set()
        self._loaded_skill_prompts = {}
        self._skill_display_names = {}

    def _run(
        self,
        skill_name: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Load skill and return prompt content.

        If the skill has already been expanded in this conversation turn,
        returns a short confirmation instead of the full prompt to save tokens.

        The skill prompt is stored in _loaded_skill_prompts for system prompt injection.
        """
        if skill_name not in self.skill_names:
            return (
                f"Error: Skill '{skill_name}' is not available. "
                f"Available skills: {', '.join(self.skill_names)}"
            )

        # Check if skill was already expanded in this turn
        if skill_name in self._expanded_skills:
            return (
                f"Skill '{skill_name}' is already active in this conversation turn. "
                f"The skill instructions have been added to the system prompt."
            )

        # Find skill (user's first, then public)
        skill = self._find_skill(skill_name)
        if not skill:
            return f"Error: Skill '{skill_name}' not found."

        skill_crd = Skill.model_validate(skill.json)
        if not skill_crd.spec.prompt:
            return f"Error: Skill '{skill_name}' has no prompt content."

        prompt = skill_crd.spec.prompt

        # Load provider if defined in skill spec
        # Pass skill.user_id for security check (only public skills can load code)
        self._load_skill_provider(skill.id, skill_name, skill_crd, skill.user_id)

        # Mark skill as expanded for this turn and store the prompt
        self._expanded_skills.add(skill_name)
        self._loaded_skill_prompts[skill_name] = prompt

        # Cache the display name for friendly UI display
        if skill_crd.spec.displayName:
            self._skill_display_names[skill_name] = skill_crd.spec.displayName

        # Return a confirmation message (the actual prompt will be injected into system prompt)
        return f"Skill '{skill_name}' has been loaded. The instructions have been added to the system prompt. Please follow them strictly."

    def _find_skill(self, skill_name: str) -> Kind | None:
        """Find skill by name (user's first, then public)."""
        # User's skill
        skill = (
            self.db.query(Kind)
            .filter(
                Kind.user_id == self.user_id,
                Kind.kind == "Skill",
                Kind.name == skill_name,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if skill:
            return skill

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

    def _load_skill_provider(
        self, skill_id: int, skill_name: str, skill_crd: Skill, skill_user_id: int
    ) -> None:
        """Load and register the skill's provider if defined.

        This method checks if the skill has a provider configuration,
        and if so, loads the provider from the skill's ZIP package
        and registers it with the SkillToolRegistry.

        SECURITY: Only public skills (user_id=0) are allowed to load code.
        This prevents arbitrary code execution from user-uploaded skills.

        Args:
            skill_id: Database ID of the skill
            skill_name: Name of the skill
            skill_crd: Parsed Skill CRD object
            skill_user_id: User ID of the skill owner (0 for public skills)
        """
        # Check if skill has provider configuration
        if not skill_crd.spec.provider:
            return

        provider_config = skill_crd.spec.provider
        class_name = getattr(provider_config, "class_name", None)
        if not class_name:
            return

        # SECURITY CHECK: Only allow code loading for public skills (user_id=0)
        is_public = skill_user_id == 0
        if not is_public:
            logger.warning(
                "[LoadSkillTool] SECURITY: Blocked code loading for non-public "
                "skill '%s' (user_id=%d). Only public skills can load code.",
                skill_name,
                skill_user_id,
            )
            return

        # Get the registry
        registry = SkillToolRegistry.get_instance()

        # Convert provider config to dict for the registry
        provider_config_dict = {
            "module": provider_config.module,
            "class": class_name,
        }

        # Check if we need to load the provider
        # We'll try to load it and let the registry handle deduplication
        try:
            # Get skill binary from database
            skill_binary = (
                self.db.query(SkillBinary)
                .filter(SkillBinary.kind_id == skill_id)
                .first()
            )

            if not skill_binary or not skill_binary.binary_data:
                logger.warning(
                    "[LoadSkillTool] No binary data found for skill '%s' (id=%d)",
                    skill_name,
                    skill_id,
                )
                return

            # Load and register the provider
            registry.ensure_provider_loaded(
                skill_name=skill_name,
                provider_config=provider_config_dict,
                zip_content=skill_binary.binary_data,
                is_public=is_public,
            )

        except Exception as e:
            logger.error(
                "[LoadSkillTool] Failed to load provider for skill '%s': %s",
                skill_name,
                str(e),
            )

    def clear_expanded_skills(self) -> None:
        """Clear the expanded skills cache and loaded prompts.

        Call this method when starting a new conversation turn
        (after the AI has finished responding to the user).
        """
        self._expanded_skills.clear()
        self._loaded_skill_prompts.clear()

    def get_expanded_skills(self) -> set[str]:
        """Get the set of skills that have been expanded in this turn.

        Returns:
            Set of skill names that have been expanded
        """
        return self._expanded_skills.copy()

    def get_loaded_skill_prompts(self) -> dict[str, str]:
        """Get all loaded skill prompts for system prompt injection.

        Returns:
            Dictionary mapping skill names to their prompts
        """
        return self._loaded_skill_prompts.copy()

    def get_skill_display_name(self, skill_name: str) -> str:
        """Get the friendly display name for a skill.

        This method returns the skill's displayName if available,
        otherwise falls back to the skill_name itself.

        Args:
            skill_name: The technical name of the skill

        Returns:
            The friendly display name or the skill_name if not found
        """
        import logging

        logger = logging.getLogger(__name__)

        # First check cache
        if skill_name in self._skill_display_names:
            logger.info(
                "[get_skill_display_name] Found in cache: skill_name=%s, display_name=%s",
                skill_name,
                self._skill_display_names[skill_name],
            )
            return self._skill_display_names[skill_name]

        # Try to load from database if not in cache
        logger.info(
            "[get_skill_display_name] Not in cache, querying DB: skill_name=%s, user_id=%s",
            skill_name,
            self.user_id,
        )
        try:
            skill = self._find_skill(skill_name)
            if skill:
                logger.info(
                    "[get_skill_display_name] Found skill in DB: name=%s, skill.json=%s",
                    skill_name,
                    skill.json,
                )
                skill_crd = Skill.model_validate(skill.json)
                logger.info(
                    "[get_skill_display_name] Parsed skill CRD: name=%s, spec.displayName=%s",
                    skill_name,
                    skill_crd.spec.displayName,
                )
                if skill_crd.spec.displayName:
                    self._skill_display_names[skill_name] = skill_crd.spec.displayName
                    return skill_crd.spec.displayName
                else:
                    logger.info(
                        "[get_skill_display_name] Skill has no displayName: skill_name=%s",
                        skill_name,
                    )
            else:
                logger.info(
                    "[get_skill_display_name] Skill not found in DB: skill_name=%s",
                    skill_name,
                )
        except Exception as e:
            logger.warning(
                "[get_skill_display_name] Error querying skill: skill_name=%s, error=%s",
                skill_name,
                str(e),
            )

        # Fallback to skill_name
        return skill_name

    def get_combined_skill_prompt(self) -> str:
        """Get combined skill prompts for system prompt injection.

        Returns:
            Combined string of all loaded skill prompts, or empty string if none loaded
        """
        if not self._loaded_skill_prompts:
            return ""

        parts = []
        for skill_name, prompt in self._loaded_skill_prompts.items():
            parts.append(f"\n\n## Skill: {skill_name}\n\n{prompt}")

        return (
            "\n\n# Loaded Skill Instructions\n\nThe following skills have been loaded. "
            + "".join(parts)
        )

    def preload_skills(self, skill_names_to_preload: list[str]) -> list[str]:
        """Preload skills that were previously used in the conversation.

        This method is used to restore skill prompts for follow-up messages.
        When a user sends a follow-up message, the LoadSkillTool instance is new
        and doesn't have the previously loaded skill prompts. This method allows
        preloading those skills so they remain effective for follow-up questions.

        Args:
            skill_names_to_preload: List of skill names to preload

        Returns:
            List of skill names that were successfully preloaded
        """
        preloaded = []
        for skill_name in skill_names_to_preload:
            if skill_name not in self.skill_names:
                continue
            if skill_name in self._expanded_skills:
                # Already loaded
                preloaded.append(skill_name)
                continue

            # Find and load the skill
            skill = self._find_skill(skill_name)
            if not skill:
                continue

            skill_crd = Skill.model_validate(skill.json)
            if not skill_crd.spec.prompt:
                continue

            prompt = skill_crd.spec.prompt

            # Load provider if defined in skill spec
            # Pass skill.user_id for security check (only public skills can load code)
            self._load_skill_provider(skill.id, skill_name, skill_crd, skill.user_id)

            # Mark skill as expanded and store the prompt
            self._expanded_skills.add(skill_name)
            self._loaded_skill_prompts[skill_name] = prompt
            preloaded.append(skill_name)

        return preloaded

    async def _arun(
        self,
        skill_name: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Async version - just calls sync version."""
        return self._run(skill_name, run_manager)
