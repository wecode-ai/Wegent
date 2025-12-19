"""Skills registry for managing built-in skills."""

from typing import List
from ..base import BaseTool, ToolRegistry
from .file_reader import FileReaderSkill, FileListSkill


class SkillsRegistry:
    """Registry for built-in skills."""

    def __init__(self, workspace_root: str = "/workspace"):
        """Initialize skills registry.

        Args:
            workspace_root: Root directory for file operations
        """
        self.workspace_root = workspace_root
        self.registry = ToolRegistry()
        self._register_default_skills()

    def _register_default_skills(self) -> None:
        """Register default skills."""
        # File operations
        self.registry.register(FileReaderSkill(self.workspace_root))
        self.registry.register(FileListSkill(self.workspace_root))

    def get_all_skills(self) -> List[BaseTool]:
        """Get all registered skills.

        Returns:
            List of skill tools
        """
        return self.registry.list_tools()

    def get_skill(self, skill_name: str) -> BaseTool | None:
        """Get skill by name.

        Args:
            skill_name: Skill name

        Returns:
            Skill tool or None
        """
        return self.registry.get(skill_name)
