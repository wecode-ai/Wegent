# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for PromptModifierTool protocol and related functionality.

This module tests:
- PromptModifierTool protocol definition
- LoadSkillTool implementation of PromptModifierTool
- LangGraphAgentBuilder auto-detection of PromptModifierTool
- Prompt modification during agent execution
"""

from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

from chat_shell.agents.graph_builder import LangGraphAgentBuilder
from chat_shell.tools.base import PromptModifierTool, ToolRegistry
from chat_shell.tools.builtin import LoadSkillTool, WebSearchTool


class TestPromptModifierToolProtocol:
    """Tests for PromptModifierTool protocol."""

    def test_protocol_is_runtime_checkable(self):
        """Test that PromptModifierTool is a runtime checkable protocol."""
        # Arrange
        tool = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})

        # Act & Assert
        assert isinstance(tool, PromptModifierTool)

    def test_non_modifier_tool_not_instance(self):
        """Test that tools without get_prompt_modification are not instances."""
        # Arrange
        tool = WebSearchTool()

        # Act & Assert
        assert not isinstance(tool, PromptModifierTool)

    def test_custom_tool_with_method_is_instance(self):
        """Test that any tool with get_prompt_modification method is an instance."""

        # Arrange
        class CustomTool:
            def get_prompt_modification(self) -> str:
                return "custom modification"

        tool = CustomTool()

        # Act & Assert
        assert isinstance(tool, PromptModifierTool)


class TestLoadSkillToolPromptModification:
    """Tests for LoadSkillTool's PromptModifierTool implementation."""

    def test_get_prompt_modification_empty_when_no_skills_loaded(self):
        """Test that get_prompt_modification returns empty string when no skills loaded."""
        # Arrange
        tool = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})

        # Act
        result = tool.get_prompt_modification()

        # Assert
        assert result == ""

    def test_get_prompt_modification_returns_content_after_preload(self):
        """Test that get_prompt_modification returns content after preloading skill."""
        # Arrange
        tool = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})
        skill_config = {"prompt": "Test instructions", "displayName": "Test Skill"}

        # Act
        tool.preload_skill_prompt("test_skill", skill_config)
        result = tool.get_prompt_modification()

        # Assert
        assert len(result) > 0
        assert "test_skill" in result
        assert "Test instructions" in result

    def test_get_prompt_modification_combines_multiple_skills(self):
        """Test that get_prompt_modification combines multiple skill prompts."""
        # Arrange
        tool = LoadSkillTool(
            user_id=1, skill_names=["skill1", "skill2"], skill_metadata={}
        )

        # Act
        tool.preload_skill_prompt("skill1", {"prompt": "Instructions 1"})
        tool.preload_skill_prompt("skill2", {"prompt": "Instructions 2"})
        result = tool.get_prompt_modification()

        # Assert
        assert "skill1" in result
        assert "skill2" in result
        assert "Instructions 1" in result
        assert "Instructions 2" in result

    def test_get_combined_skill_prompt_is_alias(self):
        """Test that get_combined_skill_prompt is an alias for get_prompt_modification."""
        # Arrange
        tool = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})
        tool.preload_skill_prompt("test", {"prompt": "Test"})

        # Act
        result1 = tool.get_prompt_modification()
        result2 = tool.get_combined_skill_prompt()

        # Assert
        assert result1 == result2


class TestLangGraphAgentBuilderPromptModifierDetection:
    """Tests for LangGraphAgentBuilder's auto-detection of PromptModifierTool."""

    def test_no_modifier_tools_detected_when_none_registered(self):
        """Test that no modifier tools are detected when none are registered."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()
        registry.register(WebSearchTool())

        # Act
        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)

        # Assert
        assert len(builder._prompt_modifier_tools) == 0

    def test_modifier_tool_detected_when_registered(self):
        """Test that modifier tools are detected when registered."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()
        load_skill = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})
        registry.register(load_skill)

        # Act
        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)

        # Assert
        assert len(builder._prompt_modifier_tools) == 1
        assert builder._prompt_modifier_tools[0].name == "load_skill"

    def test_multiple_modifier_tools_detected(self):
        """Test that multiple modifier tools are detected."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()

        # Create two LoadSkillTool instances with different names
        tool1 = LoadSkillTool(user_id=1, skill_names=["skill1"], skill_metadata={})
        tool1.name = "load_skill_1"
        tool2 = LoadSkillTool(user_id=2, skill_names=["skill2"], skill_metadata={})
        tool2.name = "load_skill_2"

        registry.register(tool1)
        registry.register(tool2)

        # Act
        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)

        # Assert
        assert len(builder._prompt_modifier_tools) == 2

    def test_prompt_modifier_is_none_when_no_modifier_tools(self):
        """Test that _create_prompt_modifier returns None when no modifier tools."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()
        registry.register(WebSearchTool())

        # Act
        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)
        prompt_modifier = builder._create_prompt_modifier()

        # Assert
        assert prompt_modifier is None

    def test_prompt_modifier_is_callable_when_modifier_tools_exist(self):
        """Test that _create_prompt_modifier returns callable when modifier tools exist."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()
        load_skill = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})
        registry.register(load_skill)

        # Act
        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)
        prompt_modifier = builder._create_prompt_modifier()

        # Assert
        assert prompt_modifier is not None
        assert callable(prompt_modifier)


class TestPromptModifierFunction:
    """Tests for the prompt_modifier function created by LangGraphAgentBuilder."""

    def test_prompt_modifier_returns_unchanged_when_no_modifications(self):
        """Test that prompt_modifier returns messages unchanged when no modifications."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()
        load_skill = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})
        registry.register(load_skill)

        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)
        prompt_modifier = builder._create_prompt_modifier()

        messages = [
            SystemMessage(content="Original system prompt"),
            HumanMessage(content="Hello"),
        ]
        state = {"messages": messages}

        # Act
        result = prompt_modifier(state)

        # Assert
        assert len(result) == 2
        assert result[0].content == "Original system prompt"

    def test_prompt_modifier_appends_to_system_message(self):
        """Test that prompt_modifier appends modifications to system message."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()
        load_skill = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})
        load_skill.preload_skill_prompt("test", {"prompt": "Test instructions"})
        registry.register(load_skill)

        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)
        prompt_modifier = builder._create_prompt_modifier()

        messages = [
            SystemMessage(content="Original system prompt"),
            HumanMessage(content="Hello"),
        ]
        state = {"messages": messages}

        # Act
        result = prompt_modifier(state)

        # Assert
        assert len(result) == 2
        assert "Original system prompt" in result[0].content
        assert "Test instructions" in result[0].content

    def test_prompt_modifier_creates_system_message_if_missing(self):
        """Test that prompt_modifier creates system message if none exists."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()
        load_skill = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})
        load_skill.preload_skill_prompt("test", {"prompt": "Test instructions"})
        registry.register(load_skill)

        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)
        prompt_modifier = builder._create_prompt_modifier()

        messages = [HumanMessage(content="Hello")]
        state = {"messages": messages}

        # Act
        result = prompt_modifier(state)

        # Assert
        assert len(result) == 2
        assert isinstance(result[0], SystemMessage)
        assert "Test instructions" in result[0].content

    def test_prompt_modifier_handles_empty_messages(self):
        """Test that prompt_modifier handles empty messages list."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()
        load_skill = LoadSkillTool(user_id=1, skill_names=["test"], skill_metadata={})
        load_skill.preload_skill_prompt("test", {"prompt": "Test instructions"})
        registry.register(load_skill)

        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)
        prompt_modifier = builder._create_prompt_modifier()

        state = {"messages": []}

        # Act
        result = prompt_modifier(state)

        # Assert
        assert result == []

    def test_prompt_modifier_combines_multiple_tool_modifications(self):
        """Test that prompt_modifier combines modifications from multiple tools."""
        # Arrange
        mock_llm = MagicMock()
        registry = ToolRegistry()

        tool1 = LoadSkillTool(user_id=1, skill_names=["skill1"], skill_metadata={})
        tool1.name = "load_skill_1"
        tool1.preload_skill_prompt("skill1", {"prompt": "Instructions 1"})

        tool2 = LoadSkillTool(user_id=2, skill_names=["skill2"], skill_metadata={})
        tool2.name = "load_skill_2"
        tool2.preload_skill_prompt("skill2", {"prompt": "Instructions 2"})

        registry.register(tool1)
        registry.register(tool2)

        builder = LangGraphAgentBuilder(llm=mock_llm, tool_registry=registry)
        prompt_modifier = builder._create_prompt_modifier()

        messages = [
            SystemMessage(content="Original"),
            HumanMessage(content="Hello"),
        ]
        state = {"messages": messages}

        # Act
        result = prompt_modifier(state)

        # Assert
        assert "Instructions 1" in result[0].content
        assert "Instructions 2" in result[0].content
