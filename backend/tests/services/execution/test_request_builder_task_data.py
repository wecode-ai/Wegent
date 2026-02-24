# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for TaskRequestBuilder.build() - verifying task_data is properly populated
in the ExecutionRequest for MCP placeholder replacement.
"""

from unittest.mock import MagicMock, patch

import pytest

from shared.models.execution import ExecutionRequest


class TestTaskRequestBuilderTaskData:
    """Tests that TaskRequestBuilder.build() populates task_data in ExecutionRequest."""

    def _build_mock_objects(self):
        """Create all mock objects needed for TaskRequestBuilder.build()."""
        # Mock user
        user = MagicMock()
        user.id = 42
        user.user_name = "testuser"
        user.git_info = [
            {
                "type": "github",
                "git_domain": "github.com",
                "git_token": "ghp_test_token",
                "git_id": 12345,
                "git_login": "testuser",
                "git_email": "test@example.com",
            }
        ]

        # Mock task
        task = MagicMock()
        task.id = 100
        task.json = {
            "spec": {
                "workspaceRef": {"name": "workspace1", "namespace": "default"}
            }
        }

        # Mock subtask
        subtask = MagicMock()
        subtask.id = 200
        subtask.message_id = 300
        subtask.bot_ids = None
        subtask.executor_name = None

        # Mock team
        team = MagicMock()
        team.id = 10
        team.name = "test-team"
        team.namespace = "default"
        team.user_id = 42
        team.json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "test-team", "namespace": "default"},
            "spec": {
                "collaborationModel": "solo",
                "members": [
                    {
                        "botRef": {"name": "test-bot", "namespace": "default"},
                        "role": "worker",
                    }
                ],
            },
        }

        # Mock bot
        bot = MagicMock()
        bot.id = 5
        bot.name = "test-bot"
        bot.namespace = "default"
        bot.json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "test-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "test-ghost", "namespace": "default"},
                "shellRef": {"name": "test-shell", "namespace": "default"},
                "agent_config": {},
            },
        }

        return user, task, subtask, team, bot

    @patch("app.services.execution.request_builder.settings")
    def test_task_data_is_populated(self, mock_settings):
        """Test that task_data is set in the ExecutionRequest with required fields."""
        from app.services.execution.request_builder import TaskRequestBuilder

        mock_settings.CHAT_MCP_SERVERS = "{}"
        mock_settings.BACKEND_INTERNAL_URL = "http://localhost:8000"

        user, task, subtask, team, bot = self._build_mock_objects()

        # Mock the database session
        mock_db = MagicMock()

        builder = TaskRequestBuilder(mock_db)

        # Mock internal methods to isolate build() logic
        builder._get_bot_for_subtask = MagicMock(return_value=bot)
        builder._build_workspace = MagicMock(
            return_value={
                "repository": {
                    "gitUrl": "https://github.com/test/repo.git",
                    "gitDomain": "github.com",
                    "gitRepo": "test/repo",
                    "gitRepoId": 999,
                    "branchName": "main",
                }
            }
        )
        builder._build_user_info = MagicMock(
            return_value={
                "id": 42,
                "name": "testuser",
                "git_domain": "github.com",
                "git_token": "ghp_test_token",
                "git_id": 12345,
                "git_login": "testuser",
                "git_email": "test@example.com",
            }
        )
        builder._get_model_config = MagicMock(
            return_value={
                "provider": "anthropic",
                "model_id": "claude-3-5-sonnet",
                "api_key": "sk-test",
            }
        )
        builder._get_base_system_prompt = MagicMock(return_value="You are a helper.")
        builder._get_bot_skills = MagicMock(return_value=([], [], []))
        builder._build_bot_config = MagicMock(
            return_value=[
                {
                    "id": 5,
                    "name": "test-bot",
                    "shell_type": "chat",
                }
            ]
        )
        builder._build_mcp_servers = MagicMock(return_value=[])
        builder._is_group_chat = MagicMock(return_value=False)
        builder._generate_auth_token = MagicMock(return_value="mock-jwt-token")

        result = builder.build(
            subtask=subtask,
            task=task,
            user=user,
            team=team,
            message="Hello",
        )

        # Verify task_data is set
        assert result.task_data is not None, "task_data should not be None"

        # Verify required fields for MCP placeholder replacement
        td = result.task_data
        assert td["task_id"] == 100
        assert td["subtask_id"] == 200
        assert td["team_id"] == 10
        assert "user" in td
        assert td["user"]["name"] == "testuser"
        assert td["user"]["id"] == 42
        assert td["git_repo"] == "test/repo"
        assert td["git_url"] == "https://github.com/test/repo.git"
        assert td["git_domain"] == "github.com"
        assert td["branch_name"] == "main"
        assert "bot" in td

    @patch("app.services.execution.request_builder.settings")
    def test_task_data_user_matches_user_info(self, mock_settings):
        """Test that task_data['user'] matches the user_info built by the builder."""
        from app.services.execution.request_builder import TaskRequestBuilder

        mock_settings.CHAT_MCP_SERVERS = "{}"
        mock_settings.BACKEND_INTERNAL_URL = "http://localhost:8000"

        user, task, subtask, team, bot = self._build_mock_objects()
        mock_db = MagicMock()
        builder = TaskRequestBuilder(mock_db)

        expected_user_info = {
            "id": 42,
            "name": "testuser",
            "git_domain": "github.com",
            "git_token": "ghp_test_token",
            "git_id": 12345,
            "git_login": "testuser",
            "git_email": "test@example.com",
        }

        builder._get_bot_for_subtask = MagicMock(return_value=bot)
        builder._build_workspace = MagicMock(
            return_value={"repository": {"gitUrl": None, "gitDomain": None}}
        )
        builder._build_user_info = MagicMock(return_value=expected_user_info)
        builder._get_model_config = MagicMock(return_value={})
        builder._get_base_system_prompt = MagicMock(return_value="")
        builder._get_bot_skills = MagicMock(return_value=([], [], []))
        builder._build_bot_config = MagicMock(return_value=[])
        builder._build_mcp_servers = MagicMock(return_value=[])
        builder._is_group_chat = MagicMock(return_value=False)
        builder._generate_auth_token = MagicMock(return_value="token")

        result = builder.build(
            subtask=subtask, task=task, user=user, team=team, message="hi"
        )

        # task_data["user"] should be the same dict as user_info in the request
        assert result.task_data["user"] == result.user

    @patch("app.services.execution.request_builder.settings")
    def test_task_data_handles_no_workspace(self, mock_settings):
        """Test that task_data handles missing workspace gracefully."""
        from app.services.execution.request_builder import TaskRequestBuilder

        mock_settings.CHAT_MCP_SERVERS = "{}"
        mock_settings.BACKEND_INTERNAL_URL = "http://localhost:8000"

        user, task, subtask, team, bot = self._build_mock_objects()
        mock_db = MagicMock()
        builder = TaskRequestBuilder(mock_db)

        builder._get_bot_for_subtask = MagicMock(return_value=bot)
        # Empty workspace (no repo configured)
        builder._build_workspace = MagicMock(return_value={})
        builder._build_user_info = MagicMock(
            return_value={"id": 42, "name": "testuser"}
        )
        builder._get_model_config = MagicMock(return_value={})
        builder._get_base_system_prompt = MagicMock(return_value="")
        builder._get_bot_skills = MagicMock(return_value=([], [], []))
        builder._build_bot_config = MagicMock(return_value=[])
        builder._build_mcp_servers = MagicMock(return_value=[])
        builder._is_group_chat = MagicMock(return_value=False)
        builder._generate_auth_token = MagicMock(return_value="token")

        result = builder.build(
            subtask=subtask, task=task, user=user, team=team, message="hi"
        )

        # task_data should still be set, git fields will be None
        assert result.task_data is not None
        assert result.task_data["git_repo"] is None
        assert result.task_data["git_url"] is None
        assert result.task_data["git_domain"] is None
        assert result.task_data["branch_name"] is None
        # user info should still be present
        assert result.task_data["user"]["name"] == "testuser"
