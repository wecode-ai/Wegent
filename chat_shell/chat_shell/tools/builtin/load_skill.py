# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load skill tool for on-demand skill prompt expansion.

This tool implements session-level skill expansion caching with persistence:
- Within a single user-AI conversation turn, a skill only needs to be expanded once
- Subsequent calls to the same skill in the same turn return a confirmation message
- Skills remain loaded for up to 5 conversation turns (configurable via SKILL_RETENTION_TURNS)
- After 5 turns without being used, skills are automatically unloaded
- Skill state is restored from chat history when a new conversation turn starts

In HTTP mode, skill prompts are obtained from the skill_configs passed via ChatRequest.
"""

import logging
from typing import Any, Optional, Set

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

logger = logging.getLogger(__name__)

# Default number of turns to retain a loaded skill
DEFAULT_SKILL_RETENTION_TURNS = 5


class LoadSkillInput(BaseModel):
    """Input schema for load_skill tool."""

    skill_name: str = Field(description="The name of the skill to load")


class LoadSkillTool(BaseTool):
    """Tool to load a skill and get its full prompt content.

    This tool enables on-demand skill expansion - instead of including
    all skill prompts in the system prompt, skills are loaded only
    when needed, keeping the context window efficient.

    Session-level caching with persistence:
    - Skills are cached within a single conversation turn (one user message -> AI response)
    - First call returns the full prompt, subsequent calls return a short confirmation
    - This prevents redundant prompt expansion during multi-tool-call cycles
    - Skills remain loaded for up to 5 conversation turns (configurable)
    - Skill state is restored from chat history at the start of each turn

    Dynamic tool loading:
    - Skill tools are registered with this tool via register_skill_tools()
    - When a skill is loaded, its tools become available for the model to use
    - The get_available_tools() method returns all tools for loaded skills
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
    # Number of turns to retain a loaded skill (default: 5)
    skill_retention_turns: int = DEFAULT_SKILL_RETENTION_TURNS

    # Private instance attribute for session-level cache (not shared between instances)
    # This tracks which skills have been expanded in the current conversation turn
    _expanded_skills: Set[str] = PrivateAttr(default_factory=set)

    # Store the actual skill prompts that have been loaded (for system prompt injection)
    _loaded_skill_prompts: dict[str, str] = PrivateAttr(default_factory=dict)

    # Cache for skill display names (skill_name -> displayName)
    _skill_display_names: dict[str, str] = PrivateAttr(default_factory=dict)

    # Store skill tools for dynamic tool selection
    # skill_name -> list of tools
    _skill_tools: dict[str, list] = PrivateAttr(default_factory=dict)

    # Track remaining turns for each loaded skill
    # skill_name -> remaining_turns (decremented each turn, skill unloaded when 0)
    _skill_remaining_turns: dict[str, int] = PrivateAttr(default_factory=dict)

    # Flag to indicate if state was restored from history
    _state_restored: bool = PrivateAttr(default=False)

    def __init__(self, **data):
        """Initialize with a fresh expanded_skills cache."""
        super().__init__(**data)
        self._expanded_skills = set()
        self._loaded_skill_prompts = {}
        self._skill_display_names = {}
        self._skill_tools = {}
        self._skill_remaining_turns = {}
        self._state_restored = False

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
            # Reset the remaining turns counter since skill is being used again
            self._skill_remaining_turns[skill_name] = self.skill_retention_turns
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

        # Set the remaining turns counter for this skill
        self._skill_remaining_turns[skill_name] = self.skill_retention_turns

        # Cache the display name for friendly UI display
        display_name = skill_info.get("displayName")
        if display_name:
            self._skill_display_names[skill_name] = display_name

        logger.info(
            "[LoadSkillTool] Loaded skill '%s' with %d turns retention",
            skill_name,
            self.skill_retention_turns,
        )

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

        Priority:
        1. Check cache (_skill_display_names) for previously loaded skills
        2. Check skill_metadata for skills not yet loaded
        3. Fall back to skill_name

        Args:
            skill_name: The technical name of the skill

        Returns:
            The friendly display name or the skill_name if not found
        """
        # First check cache (for already loaded skills)
        if skill_name in self._skill_display_names:
            return self._skill_display_names[skill_name]

        # Then check skill_metadata (for skills not yet loaded)
        skill_info = self.skill_metadata.get(skill_name, {})
        display_name = skill_info.get("displayName")
        if display_name:
            # Cache it for future use
            self._skill_display_names[skill_name] = display_name
            return display_name

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

    def get_prompt_modification(self) -> str:
        """Get prompt modification content for system prompt injection.

        This method implements the PromptModifierTool protocol, allowing
        LangGraphAgentBuilder to automatically detect and use this tool
        for dynamic prompt modification.

        Returns:
            Combined string of all loaded skill prompts wrapped in <skill> tags,
            or empty string if none loaded
        """
        if not self._loaded_skill_prompts:
            logger.debug("[LoadSkillTool.get_combined_skill_prompt] No loaded skills")
            return ""

        parts = []
        for skill_name, prompt in self._loaded_skill_prompts.items():
            # Include skill path for model reference (e.g., for read_file tool)
            skill_path = f"~/.claude/skills/{skill_name}"
            parts.append(
                f"\n\n## Skill: {skill_name}\n\n"
                f"**Skill Path**: `{skill_path}`\n\n"
                f"**Note**: All file paths mentioned in this skill's instructions are relative to the Skill Path above. "
                f"When accessing files, prepend the Skill Path to get the absolute path.\n\n"
                f"{prompt}"
            )

        return (
            "\n\n<skill>\n# Loaded Skill Instructions\n\nThe following skills have been loaded. "
            + "".join(parts)
            + "\n</skill>"
        )

    # Alias for backward compatibility
    def get_combined_skill_prompt(self) -> str:
        """Alias for get_prompt_modification for backward compatibility."""
        return self.get_prompt_modification()

    def register_skill_tools(self, skill_name: str, tools: list) -> None:
        """Register tools for a skill.

        This method is called by prepare_skill_tools to register all tools
        for a skill. These tools will become available when the skill is loaded.

        Args:
            skill_name: The name of the skill
            tools: List of tool instances for this skill
        """
        self._skill_tools[skill_name] = tools
        logger.debug(
            "[LoadSkillTool] Registered %d tools for skill '%s': %s",
            len(tools),
            skill_name,
            [t.name for t in tools],
        )

    def get_skill_tools(self, skill_name: str) -> list:
        """Get tools for a specific skill.

        Args:
            skill_name: The name of the skill

        Returns:
            List of tool instances for the skill, or empty list if not found
        """
        return self._skill_tools.get(skill_name, [])

    def get_available_tools(self) -> list:
        """Get all tools for loaded/expanded skills.

        This method returns tools only for skills that have been loaded
        (either preloaded or loaded via load_skill tool).

        Returns:
            List of tool instances for all loaded skills
        """
        available_tools = []
        for skill_name in self._expanded_skills:
            skill_tools = self._skill_tools.get(skill_name, [])
            available_tools.extend(skill_tools)
        return available_tools

    def get_all_registered_tools(self) -> list:
        """Get all registered tools regardless of skill load status.

        This method returns all tools that have been registered,
        regardless of whether their skills have been loaded.
        Used by LangGraphAgentBuilder to know all possible tools.

        Returns:
            List of all registered tool instances
        """
        all_tools = []
        for tools in self._skill_tools.values():
            all_tools.extend(tools)
        return all_tools

    def is_skill_loaded(self, skill_name: str) -> bool:
        """Check if a skill has been loaded.

        Args:
            skill_name: The name of the skill

        Returns:
            True if the skill has been loaded, False otherwise
        """
        return skill_name in self._expanded_skills

    def get_loaded_skills(self) -> set[str]:
        """Get the set of loaded skill names.

        Returns:
            Set of skill names that have been loaded
        """
        return self._expanded_skills.copy()

    def get_skill_remaining_turns(self, skill_name: str) -> int:
        """Get the remaining turns for a loaded skill.

        Args:
            skill_name: The name of the skill

        Returns:
            Remaining turns, or 0 if skill is not loaded
        """
        return self._skill_remaining_turns.get(skill_name, 0)

    def restore_from_history(self, history: list[dict[str, Any]]) -> None:
        """Restore skill loading state from chat history.

        This method analyzes the chat history to find load_skill tool calls
        and restores the skill loading state. It counts the number of conversation
        turns since each skill was loaded and only restores skills that are still
        within the retention window.

        A conversation turn is defined as a user message followed by an assistant response.
        The method counts turns backwards from the most recent message.

        Args:
            history: List of message dictionaries with 'role' and 'content' keys.
                    May also contain 'tool_calls' for assistant messages.
        """
        if self._state_restored:
            logger.debug(
                "[LoadSkillTool] State already restored, skipping restore_from_history"
            )
            return

        if not history:
            logger.debug("[LoadSkillTool] No history to restore from")
            self._state_restored = True
            return

        # Find all load_skill tool calls and their positions (turn index)
        # We need to count turns from the end of history
        skill_load_turns: dict[str, int] = {}  # skill_name -> turns_ago

        # Count conversation turns (user-assistant pairs) from the end
        current_turn = 0
        i = len(history) - 1

        while i >= 0:
            msg = history[i]
            role = msg.get("role", "")

            if role == "assistant":
                # Check for load_skill tool calls in this assistant message
                content = msg.get("content", "")

                # Look for load_skill tool call patterns in the content
                # The tool result is typically in the format:
                # "Skill 'skill_name' has been loaded..."
                loaded_skills = self._extract_loaded_skills_from_content(content)
                for skill_name in loaded_skills:
                    # Only record the most recent load (closest to current turn)
                    if skill_name not in skill_load_turns:
                        skill_load_turns[skill_name] = current_turn
                        logger.debug(
                            "[LoadSkillTool] Found skill '%s' loaded %d turns ago",
                            skill_name,
                            current_turn,
                        )

                # Move to the previous message
                i -= 1

                # If the previous message is a user message, we've completed a turn
                if i >= 0 and history[i].get("role") == "user":
                    current_turn += 1
                    i -= 1
            else:
                # Skip non-assistant messages when not paired
                i -= 1

        # Restore skills that are still within the retention window
        restored_count = 0
        for skill_name, turns_ago in skill_load_turns.items():
            remaining_turns = self.skill_retention_turns - turns_ago

            if remaining_turns > 0 and skill_name in self.skill_names:
                # Restore this skill
                skill_info = self.skill_metadata.get(skill_name, {})
                prompt = skill_info.get("prompt", "")

                if prompt:
                    self._expanded_skills.add(skill_name)
                    self._loaded_skill_prompts[skill_name] = prompt
                    self._skill_remaining_turns[skill_name] = remaining_turns

                    # Cache display name
                    display_name = skill_info.get("displayName")
                    if display_name:
                        self._skill_display_names[skill_name] = display_name

                    restored_count += 1
                    logger.info(
                        "[LoadSkillTool] Restored skill '%s' from history "
                        "(loaded %d turns ago, %d turns remaining)",
                        skill_name,
                        turns_ago,
                        remaining_turns,
                    )
            elif remaining_turns <= 0:
                logger.debug(
                    "[LoadSkillTool] Skill '%s' expired (loaded %d turns ago, "
                    "retention=%d turns)",
                    skill_name,
                    turns_ago,
                    self.skill_retention_turns,
                )

        self._state_restored = True
        logger.info(
            "[LoadSkillTool] Restored %d skills from history (retention=%d turns)",
            restored_count,
            self.skill_retention_turns,
        )

    def _extract_loaded_skills_from_content(self, content: str) -> list[str]:
        """Extract skill names from assistant message content.

        This method looks for patterns indicating that a skill was loaded,
        such as the load_skill tool result message.

        Args:
            content: The assistant message content

        Returns:
            List of skill names that were loaded in this message
        """
        import re

        loaded_skills = []

        if not content or not isinstance(content, str):
            return loaded_skills

        # Pattern 1: Match the load_skill tool result message
        # "Skill 'skill_name' has been loaded..."
        pattern1 = r"Skill '([^']+)' has been loaded"
        matches = re.findall(pattern1, content)
        loaded_skills.extend(matches)

        # Pattern 2: Match the "already active" message (skill was loaded earlier in same turn)
        # "Skill 'skill_name' is already active..."
        pattern2 = r"Skill '([^']+)' is already active"
        matches = re.findall(pattern2, content)
        loaded_skills.extend(matches)

        # Filter to only include skills that are available in this session
        valid_skills = [s for s in loaded_skills if s in self.skill_names]

        return valid_skills

    def is_state_restored(self) -> bool:
        """Check if state has been restored from history.

        Returns:
            True if restore_from_history has been called, False otherwise
        """
        return self._state_restored
