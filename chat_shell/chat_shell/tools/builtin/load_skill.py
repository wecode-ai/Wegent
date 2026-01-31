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

Key features:
- Batch loading: Supports loading multiple skills in a single call
- Dependency resolution: Automatically loads skill dependencies in topological order
- Backward compatible: Single skill_name input still works

In HTTP mode, skill prompts are obtained from the skill_configs passed via ChatRequest.
"""

import logging
from typing import Any, List, Optional, Set, Union

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr, field_validator

logger = logging.getLogger(__name__)

# Default number of turns to retain a loaded skill
DEFAULT_SKILL_RETENTION_TURNS = 5


class LoadSkillInput(BaseModel):
    """Input schema for load_skill tool.

    Supports both single skill name (string) and multiple skill names (list).
    For backward compatibility, both formats are accepted.
    """

    skill_names: Union[str, List[str]] = Field(
        description="The name(s) of the skill(s) to load. "
        "Can be a single skill name (string) or multiple skill names (list). "
        "Dependencies will be automatically loaded in the correct order."
    )

    @field_validator("skill_names", mode="before")
    @classmethod
    def normalize_skill_names(cls, v):
        """Normalize input to always be a list."""
        if isinstance(v, str):
            return [v]
        return v


class LoadSkillTool(BaseTool):
    """Tool to load skill(s) and inject their prompts into the system context.

    This tool enables on-demand skill expansion - instead of including
    all skill prompts in the system prompt, skills are loaded only
    when needed, keeping the context window efficient.

    Key features:
    - Batch loading: Load multiple skills in one call
    - Dependency resolution: Automatically loads dependencies recursively
    - Topological ordering: Dependencies are loaded before dependent skills
    - Deduplication: Each skill is only loaded once, even if requested multiple times

    Session-level caching with persistence:
    - Skills are cached within a single conversation turn (one user message -> AI response)
    - First call loads the skill, subsequent calls confirm it's still active
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
        "Load skill(s) to get specialized guidance and instructions. "
        "Call this tool when your task matches one of the available skills' descriptions. "
        "You can load a single skill by name or multiple skills at once using a list. "
        "Dependencies will be automatically loaded in the correct order. "
        "The skill instructions will be added to the system prompt. "
        "Note: Within the same response, already loaded skills will be confirmed as active."
    )
    args_schema: type[BaseModel] = LoadSkillInput

    # Configuration - these are set when creating the tool instance
    user_id: int
    skill_names: list[str]  # Available skill names for this session
    # Skill metadata from ChatRequest (skill_configs)
    # skill_name -> {description, prompt, displayName, dependencies, ...}
    skill_metadata: dict[str, dict] = {}
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

    def _resolve_dependencies(
        self, requested_skills: List[str]
    ) -> tuple[List[str], List[str], List[str]]:
        """Resolve all dependencies for requested skills using topological sort.

        This method recursively collects all dependencies and returns them
        in topological order (dependencies before dependents).

        Args:
            requested_skills: List of skill names to load

        Returns:
            Tuple of (load_order, skipped_already_loaded, not_found):
            - load_order: Skills in topological order (dependencies first)
            - skipped_already_loaded: Skills that are already loaded
            - not_found: Skills that don't exist
        """
        all_skills: Set[str] = set()
        load_order: List[str] = []
        skipped_already_loaded: List[str] = []
        not_found: List[str] = []

        def collect_deps(skill_name: str, visited: Set[str], rec_stack: Set[str]):
            """Collect dependencies using DFS with cycle detection."""
            if skill_name in visited:
                return

            # Check if skill exists
            if skill_name not in self.skill_names:
                if skill_name not in not_found:
                    not_found.append(skill_name)
                return

            # Check if already loaded
            if skill_name in self._expanded_skills:
                if skill_name not in skipped_already_loaded:
                    skipped_already_loaded.append(skill_name)
                    # Reset retention counter since skill is being requested again
                    self._skill_remaining_turns[skill_name] = self.skill_retention_turns
                return

            # Mark as visiting (for cycle detection - should not happen if backend validated)
            rec_stack.add(skill_name)

            # Get skill dependencies
            skill_info = self.skill_metadata.get(skill_name, {})
            dependencies = skill_info.get("dependencies") or []

            # Process dependencies first
            for dep in dependencies:
                if dep in rec_stack:
                    # Circular dependency detected - skip to avoid infinite loop
                    # This shouldn't happen if backend validates properly
                    logger.warning(
                        "[LoadSkillTool] Circular dependency detected: %s -> %s, skipping",
                        skill_name,
                        dep,
                    )
                    continue
                collect_deps(dep, visited, rec_stack)

            # Mark as visited
            visited.add(skill_name)
            rec_stack.discard(skill_name)

            # Add to load order (dependencies already added before this)
            if skill_name not in all_skills:
                all_skills.add(skill_name)
                load_order.append(skill_name)

        # Process all requested skills
        visited: Set[str] = set()
        for skill_name in requested_skills:
            collect_deps(skill_name, visited, set())

        return load_order, skipped_already_loaded, not_found

    def _load_single_skill(self, skill_name: str) -> bool:
        """Load a single skill and store its prompt.

        Args:
            skill_name: The name of the skill to load

        Returns:
            True if loaded successfully, False otherwise
        """
        # Get skill metadata
        skill_info = self.skill_metadata.get(skill_name, {})
        prompt = skill_info.get("prompt", "")

        if not prompt:
            logger.warning(
                "[LoadSkillTool] Skill '%s' has no prompt content", skill_name
            )
            return False

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

        return True

    def _run(
        self,
        skill_names: Union[str, List[str]],
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Load skill(s) and return status summary.

        Args:
            skill_names: Single skill name or list of skill names to load

        Returns:
            Status summary of the loading operation
        """
        # Normalize input to list
        if isinstance(skill_names, str):
            requested_skills = [skill_names]
        else:
            requested_skills = skill_names

        # Resolve dependencies and get load order
        load_order, skipped, not_found = self._resolve_dependencies(requested_skills)

        # Track results
        loaded_skills: List[str] = []
        failed_skills: List[str] = []
        dependency_skills: List[str] = []  # Track which are dependencies vs requested

        # Identify which skills are dependencies (not in original request)
        requested_set = set(requested_skills)

        # Load skills in order
        for skill_name in load_order:
            is_dependency = skill_name not in requested_set

            if self._load_single_skill(skill_name):
                if is_dependency:
                    dependency_skills.append(skill_name)
                loaded_skills.append(skill_name)
            else:
                failed_skills.append(skill_name)

        # Build response summary
        return self._build_response_summary(
            loaded_skills=loaded_skills,
            dependency_skills=dependency_skills,
            skipped_skills=skipped,
            not_found_skills=not_found,
            failed_skills=failed_skills,
        )

    def _build_response_summary(
        self,
        loaded_skills: List[str],
        dependency_skills: List[str],
        skipped_skills: List[str],
        not_found_skills: List[str],
        failed_skills: List[str],
    ) -> str:
        """Build a human-readable response summary.

        Args:
            loaded_skills: Skills that were successfully loaded (including dependencies)
            dependency_skills: Skills loaded as dependencies (subset of loaded_skills)
            skipped_skills: Skills that were already loaded
            not_found_skills: Skills that don't exist
            failed_skills: Skills that failed to load (e.g., no prompt)

        Returns:
            Formatted status summary
        """
        total_loaded = len(loaded_skills)
        total_skipped = len(skipped_skills)
        total_failed = len(not_found_skills) + len(failed_skills)

        # All skills already loaded
        if total_loaded == 0 and total_skipped > 0 and total_failed == 0:
            return (
                f"ℹ️ All requested skills are already active: {', '.join(skipped_skills)}"
            )

        # Build response parts
        parts = []

        # Success case
        if total_loaded > 0:
            if total_failed == 0 and total_skipped == 0:
                # Pure success
                parts.append(f"✅ Successfully loaded {total_loaded} skill(s):")
                for skill in loaded_skills:
                    suffix = " (dependency)" if skill in dependency_skills else ""
                    parts.append(f"  - {skill}{suffix}")
                parts.append("")
                parts.append("Skill prompts have been injected into system context.")
            else:
                # Partial success
                parts.append("⚠️ Skill loading results:")
                if loaded_skills:
                    parts.append(f"  ✅ Loaded: {', '.join(loaded_skills)}")
                if skipped_skills:
                    parts.append(f"  ⏭️ Already active: {', '.join(skipped_skills)}")
                if not_found_skills:
                    parts.append(f"  ❌ Not found: {', '.join(not_found_skills)}")
                if failed_skills:
                    parts.append(f"  ❌ Failed: {', '.join(failed_skills)}")
                parts.append("")
                parts.append(
                    "Successfully loaded skill prompts have been injected into system context."
                )
        else:
            # All failed
            parts.append("❌ Failed to load skills:")
            if not_found_skills:
                parts.append(f"  - Not found: {', '.join(not_found_skills)}")
            if failed_skills:
                parts.append(f"  - Load failed: {', '.join(failed_skills)}")
            parts.append("")
            parts.append(f"Available skills: {', '.join(self.skill_names)}")

        return "\n".join(parts)

    async def _arun(
        self,
        skill_names: Union[str, List[str]],
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Load skill(s) asynchronously (same as sync since no I/O needed)."""
        return self._run(skill_names, run_manager)

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
            parts.append(f"\n\n## Skill: {skill_name}\n\n{prompt}")

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

        # Pattern 1: Match the new batch load result message
        # "Successfully loaded X skill(s):" followed by "- skill_name"
        pattern_batch = r"- ([a-zA-Z0-9_-]+)(?:\s+\(dependency\))?"
        batch_matches = re.findall(pattern_batch, content)
        loaded_skills.extend(batch_matches)

        # Pattern 2: Match "Loaded: skill1, skill2, ..."
        pattern_loaded = r"✅ Loaded: ([a-zA-Z0-9_,\s-]+)"
        loaded_match = re.search(pattern_loaded, content)
        if loaded_match:
            skills_str = loaded_match.group(1)
            skills = [s.strip() for s in skills_str.split(",")]
            loaded_skills.extend(skills)

        # Pattern 3: Match legacy single skill load message
        # "Skill 'skill_name' has been loaded..."
        pattern_legacy = r"Skill '([^']+)' has been loaded"
        legacy_matches = re.findall(pattern_legacy, content)
        loaded_skills.extend(legacy_matches)

        # Pattern 4: Match the "already active" message
        # "Skill 'skill_name' is already active..."
        pattern_active = r"Skill '([^']+)' is already active"
        active_matches = re.findall(pattern_active, content)
        loaded_skills.extend(active_matches)

        # Pattern 5: Match "Already active: skill1, skill2, ..."
        pattern_already = r"All requested skills are already active: ([a-zA-Z0-9_,\s-]+)"
        already_match = re.search(pattern_already, content)
        if already_match:
            skills_str = already_match.group(1)
            skills = [s.strip() for s in skills_str.split(",")]
            loaded_skills.extend(skills)

        # Filter to only include skills that are available in this session
        valid_skills = [s for s in loaded_skills if s in self.skill_names]

        return list(set(valid_skills))  # Deduplicate

    def is_state_restored(self) -> bool:
        """Check if state has been restored from history.

        Returns:
            True if restore_from_history has been called, False otherwise
        """
        return self._state_restored
