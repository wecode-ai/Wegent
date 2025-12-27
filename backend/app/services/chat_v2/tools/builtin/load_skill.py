# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load skill tool for on-demand skill prompt expansion.

This tool implements session-level skill expansion caching:
- Within a single user-AI conversation turn, a skill only needs to be expanded once
- Subsequent calls to the same skill in the same turn return a confirmation message
- When the AI finishes responding to the user, the expansion state is cleared
- The next user message starts a fresh conversation turn
"""

from typing import Set

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Skill


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

    class Config:
        arbitrary_types_allowed = True

    def __init__(self, **data):
        """Initialize with a fresh expanded_skills cache."""
        super().__init__(**data)
        self._expanded_skills = set()
        self._loaded_skill_prompts = {}

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
        
        # Mark skill as expanded for this turn and store the prompt
        self._expanded_skills.add(skill_name)
        self._loaded_skill_prompts[skill_name] = prompt

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
        
        return "\n\n# Loaded Skill Instructions\n\nThe following skills have been loaded. " + "".join(parts)

    async def _arun(
        self,
        skill_name: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Async version - just calls sync version."""
        return self._run(skill_name, run_manager)
