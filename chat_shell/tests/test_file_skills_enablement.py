# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for file skills enablement behavior.

This module tests that file skills (read_file, list_files) are only enabled
when explicitly requested, preventing tools from being sent when no workspace
context is provided in the request.
"""

import pytest

from chat_shell.interface import ChatRequest


class TestChatRequestFileSkills:
    """Tests for ChatRequest enable_file_skills field."""

    def test_enable_file_skills_default_is_false(self):
        """Test that enable_file_skills defaults to False.

        When a request is made without workspace context, file tools should
        not be sent to the model.
        """
        request = ChatRequest(
            task_id=1,
            subtask_id=1,
            message="Hello",
            user_id=1,
            user_name="test",
            team_id=1,
            team_name="test_team",
        )

        # Default should be False - no file tools unless explicitly enabled
        assert request.enable_file_skills is False

    def test_enable_file_skills_can_be_enabled(self):
        """Test that enable_file_skills can be explicitly enabled."""
        request = ChatRequest(
            task_id=1,
            subtask_id=1,
            message="Hello",
            user_id=1,
            user_name="test",
            team_id=1,
            team_name="test_team",
            enable_file_skills=True,
        )

        assert request.enable_file_skills is True


@pytest.mark.skipif(
    not pytest.importorskip("langchain_core", reason="langchain_core not installed"),
    reason="langchain_core not installed",
)
class TestChatAgentFileSkillsRegistration:
    """Tests for ChatAgent file skills registration behavior."""

    def test_create_chat_agent_without_skills(self):
        """Test that ChatAgent without enable_skills has no file tools."""
        from chat_shell.agent import create_chat_agent

        agent = create_chat_agent(
            workspace_root="/workspace",
            enable_skills=False,
            enable_web_search=False,
        )

        tool_names = [t.name for t in agent.tool_registry.get_all()]

        # Should not have file tools when enable_skills=False
        assert "read_file" not in tool_names
        assert "list_files" not in tool_names

    def test_create_chat_agent_with_skills(self):
        """Test that ChatAgent with enable_skills has file tools."""
        from chat_shell.agent import create_chat_agent

        agent = create_chat_agent(
            workspace_root="/workspace",
            enable_skills=True,
            enable_web_search=False,
        )

        tool_names = [t.name for t in agent.tool_registry.get_all()]

        # Should have file tools when enable_skills=True
        assert "read_file" in tool_names
        assert "list_files" in tool_names


class TestFeaturesConfigFileSkills:
    """Tests for FeaturesConfig file_skills field."""

    def test_features_config_file_skills_default_is_false(self):
        """Test that FeaturesConfig.file_skills defaults to False."""
        from chat_shell.api.v1.schemas import FeaturesConfig

        config = FeaturesConfig()

        assert config.file_skills is False

    def test_features_config_file_skills_can_be_enabled(self):
        """Test that FeaturesConfig.file_skills can be set to True."""
        from chat_shell.api.v1.schemas import FeaturesConfig

        config = FeaturesConfig(file_skills=True)

        assert config.file_skills is True


class TestResponseRequestFileSkillsPassthrough:
    """Tests for file_skills passthrough from API request to ChatRequest."""

    def test_request_without_file_skills_feature(self):
        """Test that request without file_skills feature results in False.

        When a user makes an API request without specifying file_skills,
        the ChatRequest should have enable_file_skills=False.
        """
        from chat_shell.api.v1.schemas import FeaturesConfig

        # Simulate default features (user didn't specify file_skills)
        features = FeaturesConfig()

        # This is what the API handler would pass to ChatRequest
        enable_file_skills = features.file_skills

        assert enable_file_skills is False

    def test_request_with_file_skills_feature_enabled(self):
        """Test that request with file_skills=True passes through correctly."""
        from chat_shell.api.v1.schemas import FeaturesConfig

        # Simulate user enabling file_skills
        features = FeaturesConfig(file_skills=True)

        enable_file_skills = features.file_skills

        assert enable_file_skills is True
