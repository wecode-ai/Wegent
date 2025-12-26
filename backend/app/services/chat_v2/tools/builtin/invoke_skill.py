# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Invoke skill tool for on-demand skill prompt expansion."""

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Skill


class InvokeSkillInput(BaseModel):
    """Input schema for invoke_skill tool."""

    skill_name: str = Field(description="The name of the skill to invoke")


class InvokeSkillTool(BaseTool):
    """Tool to invoke a skill and get its full prompt content.

    This tool enables on-demand skill expansion - instead of including
    all skill prompts in the system prompt, skills are loaded only
    when needed, keeping the context window efficient.
    """

    name: str = "invoke_skill"
    description: str = (
        "Load a skill's full instructions when you need specialized guidance. "
        "Call this tool when your task matches one of the available skills' descriptions. "
        "The skill will provide detailed instructions, examples, and best practices."
    )
    args_schema: type[BaseModel] = InvokeSkillInput

    # Configuration - these are set when creating the tool instance
    db: Session
    user_id: int
    skill_names: list[str]  # Available skill names for this session

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        skill_name: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Invoke skill and return prompt content."""
        if skill_name not in self.skill_names:
            return (
                f"Error: Skill '{skill_name}' is not available. "
                f"Available skills: {', '.join(self.skill_names)}"
            )

        # Find skill (user's first, then public)
        skill = self._find_skill(skill_name)
        if not skill:
            return f"Error: Skill '{skill_name}' not found."

        skill_crd = Skill.model_validate(skill.json)
        if not skill_crd.spec.prompt:
            return f"Error: Skill '{skill_name}' has no prompt content."

        return skill_crd.spec.prompt

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

    async def _arun(
        self,
        skill_name: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Async version - just calls sync version."""
        return self._run(skill_name, run_manager)
