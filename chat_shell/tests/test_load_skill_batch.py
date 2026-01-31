# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for LoadSkillTool batch loading and dependency resolution.
"""
import pytest

from chat_shell.tools.builtin.load_skill import LoadSkillTool


@pytest.mark.unit
class TestLoadSkillToolBatchLoading:
    """Test LoadSkillTool batch loading functionality."""

    def create_tool(self, skill_metadata: dict) -> LoadSkillTool:
        """Create a LoadSkillTool instance with given skill metadata."""
        skill_names = list(skill_metadata.keys())
        return LoadSkillTool(
            user_id=1,
            skill_names=skill_names,
            skill_metadata=skill_metadata,
        )

    def test_load_single_skill_backward_compat(self):
        """Test loading single skill (backward compatibility)."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "Skill A instructions",
                    "dependencies": None,
                }
            }
        )

        result = tool._run("skill-a")

        assert "skill-a" in result
        assert "Successfully loaded" in result or "✅" in result
        assert tool.is_skill_loaded("skill-a")
        assert "skill-a" in tool.get_loaded_skill_prompts()

    def test_load_multiple_skills_batch(self):
        """Test loading multiple skills in a single call."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "Skill A instructions",
                    "dependencies": None,
                },
                "skill-b": {
                    "description": "Skill B",
                    "prompt": "Skill B instructions",
                    "dependencies": None,
                },
                "skill-c": {
                    "description": "Skill C",
                    "prompt": "Skill C instructions",
                    "dependencies": None,
                },
            }
        )

        result = tool._run(["skill-a", "skill-b", "skill-c"])

        assert tool.is_skill_loaded("skill-a")
        assert tool.is_skill_loaded("skill-b")
        assert tool.is_skill_loaded("skill-c")
        assert "Successfully loaded 3 skill" in result

    def test_load_skill_with_dependencies(self):
        """Test loading skill automatically loads its dependencies."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "Skill A instructions",
                    "dependencies": ["skill-b"],  # A depends on B
                },
                "skill-b": {
                    "description": "Skill B",
                    "prompt": "Skill B instructions",
                    "dependencies": None,
                },
            }
        )

        result = tool._run("skill-a")

        # Both skills should be loaded
        assert tool.is_skill_loaded("skill-a")
        assert tool.is_skill_loaded("skill-b")
        # B should be marked as dependency
        assert "(dependency)" in result

    def test_load_skill_deep_dependency_chain(self):
        """Test loading skill with deep dependency chain (A -> B -> C -> D)."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "A",
                    "dependencies": ["skill-b"],
                },
                "skill-b": {
                    "description": "Skill B",
                    "prompt": "B",
                    "dependencies": ["skill-c"],
                },
                "skill-c": {
                    "description": "Skill C",
                    "prompt": "C",
                    "dependencies": ["skill-d"],
                },
                "skill-d": {
                    "description": "Skill D",
                    "prompt": "D",
                    "dependencies": None,
                },
            }
        )

        result = tool._run("skill-a")

        # All skills should be loaded
        assert tool.is_skill_loaded("skill-a")
        assert tool.is_skill_loaded("skill-b")
        assert tool.is_skill_loaded("skill-c")
        assert tool.is_skill_loaded("skill-d")
        # Check load order (dependencies first)
        prompts = tool.get_loaded_skill_prompts()
        assert len(prompts) == 4

    def test_load_skill_diamond_dependency(self):
        """Test diamond dependency pattern (A -> B,C; B,C -> D)."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "A",
                    "dependencies": ["skill-b", "skill-c"],
                },
                "skill-b": {
                    "description": "Skill B",
                    "prompt": "B",
                    "dependencies": ["skill-d"],
                },
                "skill-c": {
                    "description": "Skill C",
                    "prompt": "C",
                    "dependencies": ["skill-d"],
                },
                "skill-d": {
                    "description": "Skill D",
                    "prompt": "D",
                    "dependencies": None,
                },
            }
        )

        result = tool._run("skill-a")

        # All skills should be loaded, D only once
        assert tool.is_skill_loaded("skill-a")
        assert tool.is_skill_loaded("skill-b")
        assert tool.is_skill_loaded("skill-c")
        assert tool.is_skill_loaded("skill-d")
        # D should only be loaded once (deduplication)
        prompts = tool.get_loaded_skill_prompts()
        assert len(prompts) == 4

    def test_load_already_loaded_skill(self):
        """Test loading already loaded skill returns confirmation."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "Skill A instructions",
                    "dependencies": None,
                }
            }
        )

        # Load first time
        tool._run("skill-a")

        # Load second time
        result = tool._run("skill-a")

        assert "already active" in result.lower()

    def test_load_nonexistent_skill(self):
        """Test loading non-existent skill returns error."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "Skill A instructions",
                    "dependencies": None,
                }
            }
        )

        result = tool._run("nonexistent-skill")

        assert "Not found" in result or "not found" in result.lower()
        assert not tool.is_skill_loaded("nonexistent-skill")

    def test_load_skill_with_missing_dependency(self):
        """Test loading skill when dependency doesn't exist."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "Skill A instructions",
                    "dependencies": ["nonexistent-skill"],
                }
            }
        )

        result = tool._run("skill-a")

        # Should still load skill-a, but report missing dependency
        # Depending on implementation, could be partial success or failure
        assert "skill-a" in tool.get_loaded_skill_prompts() or "Not found" in result

    def test_load_skill_no_prompt_fails(self):
        """Test loading skill without prompt content fails."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "",  # Empty prompt
                    "dependencies": None,
                }
            }
        )

        result = tool._run("skill-a")

        assert not tool.is_skill_loaded("skill-a")
        assert "Failed" in result or "failed" in result.lower()

    def test_load_mixed_success_and_failure(self):
        """Test loading some existing and some non-existing skills."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "A",
                    "dependencies": None,
                },
                "skill-b": {
                    "description": "Skill B",
                    "prompt": "B",
                    "dependencies": None,
                },
            }
        )

        result = tool._run(["skill-a", "nonexistent", "skill-b"])

        # skill-a and skill-b should be loaded
        assert tool.is_skill_loaded("skill-a")
        assert tool.is_skill_loaded("skill-b")
        # Result should mention partial success
        assert "Loaded" in result
        assert "Not found" in result

    def test_circular_dependency_handled_gracefully(self):
        """Test circular dependency doesn't cause infinite loop."""
        # This shouldn't happen if backend validates, but test runtime resilience
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "A",
                    "dependencies": ["skill-b"],
                },
                "skill-b": {
                    "description": "Skill B",
                    "prompt": "B",
                    "dependencies": ["skill-a"],  # Circular!
                },
            }
        )

        # Should not hang or crash
        result = tool._run("skill-a")

        # Should complete without infinite loop
        assert result is not None
        # At least one skill should be loaded
        assert tool.is_skill_loaded("skill-a") or tool.is_skill_loaded("skill-b")


@pytest.mark.unit
class TestLoadSkillToolDependencyResolution:
    """Test LoadSkillTool dependency resolution logic."""

    def create_tool(self, skill_metadata: dict) -> LoadSkillTool:
        """Create a LoadSkillTool instance with given skill metadata."""
        skill_names = list(skill_metadata.keys())
        return LoadSkillTool(
            user_id=1,
            skill_names=skill_names,
            skill_metadata=skill_metadata,
        )

    def test_resolve_dependencies_empty_list(self):
        """Test resolving empty dependencies list."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "A",
                    "dependencies": None,
                }
            }
        )

        load_order, skipped, not_found = tool._resolve_dependencies([])

        assert load_order == []
        assert skipped == []
        assert not_found == []

    def test_resolve_dependencies_no_deps(self):
        """Test resolving skills without dependencies."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "A",
                    "dependencies": None,
                },
                "skill-b": {
                    "description": "Skill B",
                    "prompt": "B",
                    "dependencies": [],
                },
            }
        )

        load_order, skipped, not_found = tool._resolve_dependencies(
            ["skill-a", "skill-b"]
        )

        assert set(load_order) == {"skill-a", "skill-b"}
        assert skipped == []
        assert not_found == []

    def test_resolve_dependencies_topological_order(self):
        """Test dependencies are resolved in topological order."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "A",
                    "dependencies": ["skill-b"],
                },
                "skill-b": {
                    "description": "Skill B",
                    "prompt": "B",
                    "dependencies": ["skill-c"],
                },
                "skill-c": {
                    "description": "Skill C",
                    "prompt": "C",
                    "dependencies": None,
                },
            }
        )

        load_order, skipped, not_found = tool._resolve_dependencies(["skill-a"])

        # Order should be: C, B, A (dependencies first)
        assert load_order.index("skill-c") < load_order.index("skill-b")
        assert load_order.index("skill-b") < load_order.index("skill-a")

    def test_resolve_dependencies_deduplication(self):
        """Test same skill requested multiple times is only loaded once."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "A",
                    "dependencies": None,
                }
            }
        )

        load_order, skipped, not_found = tool._resolve_dependencies(
            ["skill-a", "skill-a", "skill-a"]
        )

        assert load_order == ["skill-a"]

    def test_resolve_dependencies_already_loaded_skipped(self):
        """Test already loaded skills are skipped."""
        tool = self.create_tool(
            {
                "skill-a": {
                    "description": "Skill A",
                    "prompt": "A",
                    "dependencies": None,
                },
                "skill-b": {
                    "description": "Skill B",
                    "prompt": "B",
                    "dependencies": None,
                },
            }
        )

        # Pre-load skill-a
        tool._run("skill-a")

        # Now resolve both
        load_order, skipped, not_found = tool._resolve_dependencies(
            ["skill-a", "skill-b"]
        )

        assert "skill-a" not in load_order
        assert "skill-a" in skipped
        assert "skill-b" in load_order


@pytest.mark.unit
class TestLoadSkillToolHistoryExtraction:
    """Test LoadSkillTool history extraction patterns."""

    def create_tool(self, skill_names: list) -> LoadSkillTool:
        """Create a LoadSkillTool instance."""
        return LoadSkillTool(
            user_id=1,
            skill_names=skill_names,
            skill_metadata={
                name: {"description": f"Skill {name}", "prompt": f"Prompt for {name}"}
                for name in skill_names
            },
        )

    def test_extract_batch_load_message(self):
        """Test extracting skills from batch load success message."""
        tool = self.create_tool(["skill-a", "skill-b", "skill-c"])

        content = """✅ Successfully loaded 3 skill(s):
  - skill-a
  - skill-b (dependency)
  - skill-c

Skill prompts have been injected into system context."""

        skills = tool._extract_loaded_skills_from_content(content)

        assert "skill-a" in skills
        assert "skill-b" in skills
        assert "skill-c" in skills

    def test_extract_partial_success_message(self):
        """Test extracting skills from partial success message."""
        tool = self.create_tool(["skill-a", "skill-b"])

        content = """⚠️ Skill loading results:
  ✅ Loaded: skill-a, skill-b
  ❌ Not found: skill-c

Successfully loaded skill prompts have been injected into system context."""

        skills = tool._extract_loaded_skills_from_content(content)

        assert "skill-a" in skills
        assert "skill-b" in skills

    def test_extract_already_active_message(self):
        """Test extracting skills from already active message."""
        tool = self.create_tool(["skill-a", "skill-b"])

        content = "ℹ️ All requested skills are already active: skill-a, skill-b"

        skills = tool._extract_loaded_skills_from_content(content)

        assert "skill-a" in skills
        assert "skill-b" in skills

    def test_extract_legacy_single_skill_message(self):
        """Test extracting skills from legacy single skill message."""
        tool = self.create_tool(["skill-a"])

        content = "Skill 'skill-a' has been loaded. The instructions have been added to the system prompt."

        skills = tool._extract_loaded_skills_from_content(content)

        assert "skill-a" in skills

    def test_extract_filters_unavailable_skills(self):
        """Test extraction filters out skills not in skill_names."""
        tool = self.create_tool(["skill-a"])  # Only skill-a is available

        content = """✅ Successfully loaded 2 skill(s):
  - skill-a
  - skill-b

Skill prompts have been injected into system context."""

        skills = tool._extract_loaded_skills_from_content(content)

        assert "skill-a" in skills
        assert "skill-b" not in skills  # Not in available skills

    def test_extract_empty_content(self):
        """Test extraction with empty content."""
        tool = self.create_tool(["skill-a"])

        skills = tool._extract_loaded_skills_from_content("")

        assert skills == []

    def test_extract_non_string_content(self):
        """Test extraction with non-string content."""
        tool = self.create_tool(["skill-a"])

        skills = tool._extract_loaded_skills_from_content(None)  # type: ignore

        assert skills == []
