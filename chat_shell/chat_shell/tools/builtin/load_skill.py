# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load skill tool for on-demand skill prompt expansion.

This tool implements session-level skill expansion caching:
- Within a single user-AI conversation turn, a skill only needs to be expanded once
- Subsequent calls to the same skill in the same turn return a confirmation message
- When the AI finishes responding to the user, the expansion state is cleared
- The next user message starts a fresh conversation turn

In HTTP mode, skill prompts are obtained from the skill_configs passed via ChatRequest.
"""

import logging
from typing import Set

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

from chat_shell.prompts.builder import PromptBuilder

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
    user_id: int
    skill_names: list[str]  # Available skill names for this session
    # Skill metadata from ChatRequest (skill_configs)
    skill_metadata: dict[str, dict] = {}  # skill_name -> {description, prompt, ...}

    # Private instance attribute for session-level cache (not shared between instances)
    # This tracks which skills have been expanded in the current conversation turn
    _expanded_skills: Set[str] = PrivateAttr(default_factory=set)

    # Store the actual skill prompts that have been loaded (for system prompt injection)
    _loaded_skill_prompts: dict[str, str] = PrivateAttr(default_factory=dict)

    # Cache for skill display names (skill_name -> displayName)
    _skill_display_names: dict[str, str] = PrivateAttr(default_factory=dict)

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
        """Load skill and return prompt content."""
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

        # Get skill metadata
        skill_info = self.skill_metadata.get(skill_name, {})
        prompt = skill_info.get("prompt", "")

        if not prompt:
            return f"Error: Skill '{skill_name}' has no prompt content."

        # Mark skill as expanded for this turn and store the prompt
        self._expanded_skills.add(skill_name)
        self._loaded_skill_prompts[skill_name] = prompt

        # Cache the display name for friendly UI display
        display_name = skill_info.get("displayName")
        if display_name:
            self._skill_display_names[skill_name] = display_name

        # Return a confirmation message (the actual prompt will be injected into system prompt)
        return f"Skill '{skill_name}' has been loaded. The instructions have been added to the system prompt. Please follow them strictly."

    async def _arun(
        self,
        skill_name: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Load skill asynchronously (same as sync since no I/O needed)."""
        return self._run(skill_name, run_manager)

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
        # First check cache
        if skill_name in self._skill_display_names:
            return self._skill_display_names[skill_name]

        # Fallback to skill_name
        return skill_name

    def preload_skill_prompt(self, skill_name: str, skill_config: dict) -> None:
        """Preload a skill's prompt for system prompt injection.

        This method is called by prepare_skill_tools to preload skill prompts
        when skill tools are directly available. This ensures the skill instructions
        are injected into the system message via prompt_modifier.

        Args:
            skill_name: The name of the skill
            skill_config: The skill configuration containing prompt and displayName
        """
        prompt = skill_config.get("prompt", "")
        if not prompt:
            return

        # Store the prompt for injection
        self._loaded_skill_prompts[skill_name] = prompt
        self._expanded_skills.add(skill_name)

        # Cache the display name
        display_name = skill_config.get("displayName")
        if display_name:
            self._skill_display_names[skill_name] = display_name

        logger.debug(
            "[LoadSkillTool] Preloaded skill prompt for '%s' (len=%d)",
            skill_name,
            len(prompt),
        )

    def get_combined_skill_prompt(self) -> str:
        """Get combined skill prompts for system prompt injection.

        Returns:
            Combined string of all loaded skill prompts, or empty string if none loaded
        """
        if not self._loaded_skill_prompts:
            return ""

        builder = PromptBuilder()
        builder.base(
            "\n\n## Loaded Skill Instructions\n\nThe following skills have been loaded. "
        )

        for skill_name, prompt in self._loaded_skill_prompts.items():
            builder.append_with_header(
                f"\n\n## Skill: {skill_name}",
                prompt,
                content_target_level=4,
            )

        return builder.build()
