# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for dynamic skill tool loading functionality.

This module tests the ability to dynamically load skill tools when
a skill is loaded via the load_skill tool.
"""

from unittest.mock import MagicMock

import pytest

from chat_shell.tools.builtin.load_skill import LoadSkillTool


class TestLoadSkillToolDynamicTools:
    """Test cases for LoadSkillTool dynamic tool management."""

    def test_register_skill_tools(self):
        """Test that skill tools can be registered."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
        )

        # Create mock tools
        mock_tool_a1 = MagicMock()
        mock_tool_a1.name = "tool_a1"
        mock_tool_a2 = MagicMock()
        mock_tool_a2.name = "tool_a2"
        mock_tool_b1 = MagicMock()
        mock_tool_b1.name = "tool_b1"

        # Register tools for skills
        tool.register_skill_tools("skill_a", [mock_tool_a1, mock_tool_a2])
        tool.register_skill_tools("skill_b", [mock_tool_b1])

        # Verify tools are registered
        assert tool.get_skill_tools("skill_a") == [mock_tool_a1, mock_tool_a2]
        assert tool.get_skill_tools("skill_b") == [mock_tool_b1]
        assert tool.get_skill_tools("nonexistent") == []

    def test_get_available_tools_empty_when_no_skills_loaded(self):
        """Test that get_available_tools returns empty when no skills are loaded."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
        )

        # Register tools but don't load the skill
        mock_tool = MagicMock()
        mock_tool.name = "tool_a"
        tool.register_skill_tools("skill_a", [mock_tool])

        # No skills loaded, so no tools available
        assert tool.get_available_tools() == []

    def test_get_available_tools_returns_tools_for_loaded_skills(self):
        """Test that get_available_tools returns tools for loaded skills."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
        )

        # Register tools
        mock_tool_a = MagicMock()
        mock_tool_a.name = "tool_a"
        mock_tool_b = MagicMock()
        mock_tool_b.name = "tool_b"
        tool.register_skill_tools("skill_a", [mock_tool_a])
        tool.register_skill_tools("skill_b", [mock_tool_b])

        # Load only skill_a
        tool._run("skill_a")

        # Only skill_a's tools should be available
        available = tool.get_available_tools()
        assert mock_tool_a in available
        assert mock_tool_b not in available

    def test_get_available_tools_updates_after_loading_more_skills(self):
        """Test that get_available_tools updates when more skills are loaded."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
        )

        # Register tools
        mock_tool_a = MagicMock()
        mock_tool_a.name = "tool_a"
        mock_tool_b = MagicMock()
        mock_tool_b.name = "tool_b"
        tool.register_skill_tools("skill_a", [mock_tool_a])
        tool.register_skill_tools("skill_b", [mock_tool_b])

        # Initially no tools available
        assert tool.get_available_tools() == []

        # Load skill_a
        tool._run("skill_a")
        available = tool.get_available_tools()
        assert len(available) == 1
        assert mock_tool_a in available

        # Load skill_b
        tool._run("skill_b")
        available = tool.get_available_tools()
        assert len(available) == 2
        assert mock_tool_a in available
        assert mock_tool_b in available

    def test_get_all_registered_tools(self):
        """Test that get_all_registered_tools returns all tools regardless of load status."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
        )

        # Register tools
        mock_tool_a = MagicMock()
        mock_tool_a.name = "tool_a"
        mock_tool_b = MagicMock()
        mock_tool_b.name = "tool_b"
        tool.register_skill_tools("skill_a", [mock_tool_a])
        tool.register_skill_tools("skill_b", [mock_tool_b])

        # All tools should be returned regardless of load status
        all_tools = tool.get_all_registered_tools()
        assert len(all_tools) == 2
        assert mock_tool_a in all_tools
        assert mock_tool_b in all_tools

    def test_is_skill_loaded(self):
        """Test is_skill_loaded method."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
        )

        # Initially no skills loaded
        assert not tool.is_skill_loaded("skill_a")
        assert not tool.is_skill_loaded("skill_b")

        # Load skill_a
        tool._run("skill_a")
        assert tool.is_skill_loaded("skill_a")
        assert not tool.is_skill_loaded("skill_b")

    def test_get_loaded_skills(self):
        """Test get_loaded_skills method."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
        )

        # Initially empty
        assert tool.get_loaded_skills() == set()

        # Load skills
        tool._run("skill_a")
        assert tool.get_loaded_skills() == {"skill_a"}

        tool._run("skill_b")
        assert tool.get_loaded_skills() == {"skill_a", "skill_b"}

    def test_preload_skill_prompt_makes_tools_available(self):
        """Test that preloading a skill makes its tools available."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
        )

        # Register tools
        mock_tool = MagicMock()
        mock_tool.name = "tool_a"
        tool.register_skill_tools("skill_a", [mock_tool])

        # Preload the skill
        tool.preload_skill_prompt("skill_a", {"prompt": "Skill A prompt"})

        # Tools should now be available
        available = tool.get_available_tools()
        assert mock_tool in available

    def test_clear_expanded_skills_clears_available_tools(self):
        """Test that clearing expanded skills also clears available tools."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
        )

        # Register and load skill
        mock_tool = MagicMock()
        mock_tool.name = "tool_a"
        tool.register_skill_tools("skill_a", [mock_tool])
        tool._run("skill_a")

        # Tools should be available
        assert len(tool.get_available_tools()) == 1

        # Clear expanded skills
        tool.clear_expanded_skills()

        # Tools should no longer be available (but still registered)
        assert tool.get_available_tools() == []
        assert len(tool.get_all_registered_tools()) == 1


class TestDynamicToolSelectionIntegration:
    """Integration tests for dynamic tool selection with LangGraphAgentBuilder."""

    def test_model_configurator_selects_tools_based_on_loaded_skills(self):
        """Test that model configurator correctly selects tools based on loaded skills."""
        from chat_shell.agents.graph_builder import LangGraphAgentBuilder
        from chat_shell.tools.base import ToolRegistry

        # Create a LoadSkillTool with registered tools
        load_skill_tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
        )

        # Register mock tools
        mock_tool_a = MagicMock()
        mock_tool_a.name = "tool_a"
        mock_tool_b = MagicMock()
        mock_tool_b.name = "tool_b"
        load_skill_tool.register_skill_tools("skill_a", [mock_tool_a])
        load_skill_tool.register_skill_tools("skill_b", [mock_tool_b])

        # Create a mock LLM
        mock_llm = MagicMock()
        mock_llm.bind_tools = MagicMock(return_value=mock_llm)

        # Create tool registry with load_skill_tool
        tool_registry = ToolRegistry()
        tool_registry.register(load_skill_tool)

        # Create builder with load_skill_tool
        builder = LangGraphAgentBuilder(
            llm=mock_llm,
            tool_registry=tool_registry,
        )

        # Find the load_skill_tool
        found_tool = builder._find_load_skill_tool()
        assert found_tool is load_skill_tool

        # Create model configurator
        configurator, all_tools = builder._create_model_configurator()

        # Verify all_tools includes all skill tools for execution
        all_tool_names = [t.name for t in all_tools]
        assert "load_skill" in all_tool_names
        assert "tool_a" in all_tool_names
        assert "tool_b" in all_tool_names

        # Initially no skills loaded - only base tools
        # configure_model takes (state, config) as per LangGraph's callable signature
        configurator({}, None)
        call_args = mock_llm.bind_tools.call_args[0][0]
        tool_names = [t.name for t in call_args]
        assert "load_skill" in tool_names
        assert "tool_a" not in tool_names
        assert "tool_b" not in tool_names

        # Load skill_a
        load_skill_tool._run("skill_a")
        configurator({}, None)
        call_args = mock_llm.bind_tools.call_args[0][0]
        tool_names = [t.name for t in call_args]
        assert "load_skill" in tool_names
        assert "tool_a" in tool_names
        assert "tool_b" not in tool_names

        # Load skill_b
        load_skill_tool._run("skill_b")
        configurator({}, None)
        call_args = mock_llm.bind_tools.call_args[0][0]
        tool_names = [t.name for t in call_args]
        assert "load_skill" in tool_names
        assert "tool_a" in tool_names
        assert "tool_b" in tool_names

    def test_no_model_configurator_when_no_load_skill_tool(self):
        """Test that no model configurator is created when there's no LoadSkillTool."""
        from chat_shell.agents.graph_builder import LangGraphAgentBuilder
        from chat_shell.tools.base import ToolRegistry

        # Create a mock LLM
        mock_llm = MagicMock()

        # Create builder without load_skill_tool
        mock_tool = MagicMock()
        mock_tool.name = "some_tool"
        tool_registry = ToolRegistry()
        tool_registry.register(mock_tool)

        builder = LangGraphAgentBuilder(
            llm=mock_llm,
            tool_registry=tool_registry,
        )

        # Should not find load_skill_tool
        found_tool = builder._find_load_skill_tool()
        assert found_tool is None

        # Model configurator should return (None, self.tools)
        configurator, all_tools = builder._create_model_configurator()
        assert configurator is None
        # all_tools should be the same as builder.tools
        assert all_tools == builder.tools


class TestSkillRetentionAcrossTurns:
    """Test cases for skill retention across conversation turns."""

    def test_skill_remaining_turns_set_on_load(self):
        """Test that remaining turns is set when a skill is loaded."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
            skill_retention_turns=5,
        )

        # Load the skill
        tool._run("skill_a")

        # Check remaining turns is set
        assert tool.get_skill_remaining_turns("skill_a") == 5

    def test_skill_remaining_turns_reset_on_reload(self):
        """Test that remaining turns is reset when skill is loaded again."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
            skill_retention_turns=5,
        )

        # Load the skill
        tool._run("skill_a")
        assert tool.get_skill_remaining_turns("skill_a") == 5

        # Manually decrease remaining turns (simulating turns passing)
        tool._skill_remaining_turns["skill_a"] = 2

        # Load the skill again (should reset to 5)
        tool._run("skill_a")
        assert tool.get_skill_remaining_turns("skill_a") == 5

    def test_restore_from_history_empty_history(self):
        """Test restore_from_history with empty history."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
        )

        # Restore from empty history
        tool.restore_from_history([])

        # No skills should be loaded
        assert tool.get_loaded_skills() == set()
        assert tool.is_state_restored()

    def test_restore_from_history_with_loaded_skill(self):
        """Test restore_from_history restores skill loaded in recent history."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
            skill_retention_turns=5,
        )

        # Simulate history with a skill loaded 2 turns ago
        history = [
            {"role": "user", "content": "Load skill_a"},
            {
                "role": "assistant",
                "content": "Skill 'skill_a' has been loaded. The instructions have been added to the system prompt.",
            },
            {"role": "user", "content": "Do something"},
            {"role": "assistant", "content": "Done!"},
            {"role": "user", "content": "Do more"},
            {"role": "assistant", "content": "Done again!"},
        ]

        # Restore from history
        tool.restore_from_history(history)

        # Skill should be restored with remaining turns
        assert tool.is_skill_loaded("skill_a")
        # Loaded 2 turns ago, so 5 - 2 = 3 remaining
        assert tool.get_skill_remaining_turns("skill_a") == 3
        assert tool.is_state_restored()

    def test_restore_from_history_skill_expired(self):
        """Test restore_from_history does not restore expired skills."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
            skill_retention_turns=2,  # Only retain for 2 turns
        )

        # Simulate history with a skill loaded 3 turns ago (expired)
        history = [
            {"role": "user", "content": "Load skill_a"},
            {"role": "assistant", "content": "Skill 'skill_a' has been loaded."},
            {"role": "user", "content": "Turn 1"},
            {"role": "assistant", "content": "Response 1"},
            {"role": "user", "content": "Turn 2"},
            {"role": "assistant", "content": "Response 2"},
            {"role": "user", "content": "Turn 3"},
            {"role": "assistant", "content": "Response 3"},
        ]

        # Restore from history
        tool.restore_from_history(history)

        # Skill should NOT be restored (expired after 2 turns)
        assert not tool.is_skill_loaded("skill_a")
        assert tool.is_state_restored()

    def test_restore_from_history_multiple_skills(self):
        """Test restore_from_history with multiple skills loaded at different times."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
            skill_retention_turns=5,
        )

        # Simulate history with skill_a loaded 3 turns ago, skill_b loaded 1 turn ago
        history = [
            {"role": "user", "content": "Load skill_a"},
            {"role": "assistant", "content": "Skill 'skill_a' has been loaded."},
            {"role": "user", "content": "Turn 1"},
            {"role": "assistant", "content": "Response 1"},
            {"role": "user", "content": "Load skill_b"},
            {"role": "assistant", "content": "Skill 'skill_b' has been loaded."},
            {"role": "user", "content": "Turn 2"},
            {"role": "assistant", "content": "Response 2"},
        ]

        # Restore from history
        tool.restore_from_history(history)

        # Both skills should be restored
        assert tool.is_skill_loaded("skill_a")
        assert tool.is_skill_loaded("skill_b")

        # skill_a: loaded 3 turns ago, 5 - 3 = 2 remaining
        assert tool.get_skill_remaining_turns("skill_a") == 2
        # skill_b: loaded 1 turn ago, 5 - 1 = 4 remaining
        assert tool.get_skill_remaining_turns("skill_b") == 4

    def test_restore_from_history_only_restores_once(self):
        """Test that restore_from_history only runs once."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
        )

        history = [
            {"role": "user", "content": "Load skill_a"},
            {"role": "assistant", "content": "Skill 'skill_a' has been loaded."},
        ]

        # First restore
        tool.restore_from_history(history)
        assert tool.is_skill_loaded("skill_a")

        # Clear the skill manually
        tool._expanded_skills.clear()
        tool._loaded_skill_prompts.clear()

        # Second restore should not run (already restored)
        tool.restore_from_history(history)
        assert not tool.is_skill_loaded("skill_a")  # Still cleared

    def test_extract_loaded_skills_from_content(self):
        """Test _extract_loaded_skills_from_content method."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b", "skill_c"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
                "skill_c": {"description": "Skill C", "prompt": "Skill C prompt"},
            },
        )

        # Test "has been loaded" pattern
        content1 = "Skill 'skill_a' has been loaded. The instructions have been added."
        assert tool._extract_loaded_skills_from_content(content1) == ["skill_a"]

        # Test "is already active" pattern
        content2 = "Skill 'skill_b' is already active in this conversation turn."
        assert tool._extract_loaded_skills_from_content(content2) == ["skill_b"]

        # Test multiple skills in one message
        content3 = (
            "Skill 'skill_a' has been loaded. Later, Skill 'skill_b' has been loaded."
        )
        result = tool._extract_loaded_skills_from_content(content3)
        assert "skill_a" in result
        assert "skill_b" in result

        # Test unknown skill (not in skill_names)
        content4 = "Skill 'unknown_skill' has been loaded."
        assert tool._extract_loaded_skills_from_content(content4) == []

        # Test empty content
        assert tool._extract_loaded_skills_from_content("") == []
        assert tool._extract_loaded_skills_from_content(None) == []

    def test_custom_retention_turns(self):
        """Test that custom retention turns value is respected."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
            skill_retention_turns=10,  # Custom value
        )

        # Load the skill
        tool._run("skill_a")

        # Check remaining turns uses custom value
        assert tool.get_skill_remaining_turns("skill_a") == 10

    def test_default_retention_turns(self):
        """Test that default retention turns is 5."""
        from chat_shell.tools.builtin.load_skill import DEFAULT_SKILL_RETENTION_TURNS

        assert DEFAULT_SKILL_RETENTION_TURNS == 5

        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
        )

        # Load the skill
        tool._run("skill_a")

        # Check remaining turns uses default value
        assert tool.get_skill_remaining_turns("skill_a") == 5

    def test_restore_from_history_with_loaded_skills_field(self):
        """Test restore_from_history using the new loaded_skills field (primary method)."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
            skill_retention_turns=5,
        )

        # Simulate history with loaded_skills field (new format from StreamingState)
        history = [
            {"role": "user", "content": "Load skill_a"},
            {
                "role": "assistant",
                "content": "I've loaded the skill for you.",
                "loaded_skills": ["skill_a"],  # New format
            },
            {"role": "user", "content": "Do something"},
            {"role": "assistant", "content": "Done!"},
            {"role": "user", "content": "Load skill_b too"},
            {
                "role": "assistant",
                "content": "I've loaded skill_b as well.",
                "loaded_skills": ["skill_b"],  # New format
            },
        ]

        # Restore from history
        tool.restore_from_history(history)

        # Both skills should be restored
        assert tool.is_skill_loaded("skill_a")
        assert tool.is_skill_loaded("skill_b")

        # skill_a: loaded 2 turns ago, 5 - 2 = 3 remaining
        assert tool.get_skill_remaining_turns("skill_a") == 3
        # skill_b: loaded 0 turns ago (most recent), 5 - 0 = 5 remaining
        assert tool.get_skill_remaining_turns("skill_b") == 5

    def test_restore_from_history_mixed_formats(self):
        """Test restore_from_history with both old (content pattern) and new (loaded_skills field) formats."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a", "skill_b"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
                "skill_b": {"description": "Skill B", "prompt": "Skill B prompt"},
            },
            skill_retention_turns=5,
        )

        # Simulate history with mixed formats
        history = [
            {"role": "user", "content": "Load skill_a"},
            {
                "role": "assistant",
                "content": "Skill 'skill_a' has been loaded.",  # Old format (content pattern)
            },
            {"role": "user", "content": "Do something"},
            {"role": "assistant", "content": "Done!"},
            {"role": "user", "content": "Load skill_b"},
            {
                "role": "assistant",
                "content": "I've loaded skill_b.",
                "loaded_skills": ["skill_b"],  # New format
            },
        ]

        # Restore from history
        tool.restore_from_history(history)

        # Both skills should be restored (from different formats)
        assert tool.is_skill_loaded("skill_a")
        assert tool.is_skill_loaded("skill_b")

    def test_restore_from_history_loaded_skills_field_priority(self):
        """Test that loaded_skills field takes priority over content pattern for the same skill."""
        tool = LoadSkillTool(
            user_id=1,
            skill_names=["skill_a"],
            skill_metadata={
                "skill_a": {"description": "Skill A", "prompt": "Skill A prompt"},
            },
            skill_retention_turns=5,
        )

        # Simulate history where skill_a appears in both formats in the same message
        # The loaded_skills field should be processed first
        history = [
            {"role": "user", "content": "Load skill_a"},
            {
                "role": "assistant",
                "content": "Skill 'skill_a' has been loaded.",  # Old format
                "loaded_skills": ["skill_a"],  # New format (same skill)
            },
        ]

        # Restore from history
        tool.restore_from_history(history)

        # Skill should be restored (only counted once)
        assert tool.is_skill_loaded("skill_a")
        # Loaded 0 turns ago, 5 - 0 = 5 remaining
        assert tool.get_skill_remaining_turns("skill_a") == 5
