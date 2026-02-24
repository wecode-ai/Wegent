# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for TaskRequestBuilder.build() - verifying task_data is properly populated
in the ExecutionRequest for MCP placeholder replacement.
"""

from typing import Tuple
from unittest.mock import MagicMock, patch

import pytest

from shared.models.execution import ExecutionRequest

# Constants for test data
TEST_USER_ID = 42
TEST_USER_NAME = "testuser"
TEST_TASK_ID = 100
TEST_SUBTASK_ID = 200
TEST_MESSAGE_ID = 300
TEST_TEAM_ID = 10
TEST_BOT_ID = 5
TEST_GIT_TOKEN = "ghp_test_token"
TEST_GIT_DOMAIN = "github.com"
TEST_GIT_LOGIN = "testuser"
TEST_GIT_EMAIL = "test@example.com"
TEST_GIT_ID = 12345
TEST_BACKEND_URL = "http://localhost:8000"
TEST_AUTH_TOKEN = "mock-jwt-token"


def _make_user_mock() -> MagicMock:
    """Create a mock User object."""
    user = MagicMock()
    user.id = TEST_USER_ID
    user.user_name = TEST_USER_NAME
    user.git_info = [
        {
            "type": "github",
            "git_domain": TEST_GIT_DOMAIN,
            "git_token": TEST_GIT_TOKEN,
            "git_id": TEST_GIT_ID,
            "git_login": TEST_GIT_LOGIN,
            "git_email": TEST_GIT_EMAIL,
        }
    ]
    return user


def _make_task_mock() -> MagicMock:
    """Create a mock TaskResource object."""
    task = MagicMock()
    task.id = TEST_TASK_ID
    task.json = {
        "spec": {"workspaceRef": {"name": "workspace1", "namespace": "default"}}
    }
    return task


def _make_subtask_mock() -> MagicMock:
    """Create a mock Subtask object."""
    subtask = MagicMock()
    subtask.id = TEST_SUBTASK_ID
    subtask.message_id = TEST_MESSAGE_ID
    subtask.bot_ids = None
    subtask.executor_name = None
    return subtask


def _make_team_mock() -> MagicMock:
    """Create a mock Team Kind object."""
    team = MagicMock()
    team.id = TEST_TEAM_ID
    team.name = "test-team"
    team.namespace = "default"
    team.user_id = TEST_USER_ID
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
    return team


def _make_bot_mock() -> MagicMock:
    """Create a mock Bot Kind object."""
    bot = MagicMock()
    bot.id = TEST_BOT_ID
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
    return bot


class TestTaskRequestBuilderTaskData:
    """Tests that TaskRequestBuilder.build() populates task_data in ExecutionRequest."""

    @patch("app.services.execution.request_builder.settings")
    def test_task_data_is_populated(self, mock_settings: MagicMock) -> None:
        """Test that task_data is set in the ExecutionRequest with required fields."""
        from app.services.execution.request_builder import TaskRequestBuilder

        mock_settings.CHAT_MCP_SERVERS = "{}"
        mock_settings.BACKEND_INTERNAL_URL = TEST_BACKEND_URL

        user = _make_user_mock()
        task = _make_task_mock()
        subtask = _make_subtask_mock()
        team = _make_team_mock()
        bot = _make_bot_mock()

        builder = TaskRequestBuilder(MagicMock())

        builder._get_bot_for_subtask = MagicMock(return_value=bot)
        builder._build_workspace = MagicMock(
            return_value={
                "repository": {
                    "gitUrl": "https://github.com/test/repo.git",
                    "gitDomain": TEST_GIT_DOMAIN,
                    "gitRepo": "test/repo",
                    "gitRepoId": 999,
                    "branchName": "main",
                }
            }
        )
        builder._build_user_info = MagicMock(
            return_value={
                "id": TEST_USER_ID,
                "name": TEST_USER_NAME,
                "git_domain": TEST_GIT_DOMAIN,
                "git_token": TEST_GIT_TOKEN,
                "git_id": TEST_GIT_ID,
                "git_login": TEST_GIT_LOGIN,
                "git_email": TEST_GIT_EMAIL,
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
            return_value=[{"id": TEST_BOT_ID, "name": "test-bot", "shell_type": "chat"}]
        )
        builder._build_mcp_servers = MagicMock(return_value=[])
        builder._is_group_chat = MagicMock(return_value=False)
        builder._generate_auth_token = MagicMock(return_value=TEST_AUTH_TOKEN)

        result = builder.build(
            subtask=subtask, task=task, user=user, team=team, message="Hello"
        )

        # Verify task_data is set
        assert result.task_data is not None, "task_data should not be None"

        # Verify required fields for MCP placeholder replacement
        td = result.task_data
        assert td["task_id"] == TEST_TASK_ID
        assert td["subtask_id"] == TEST_SUBTASK_ID
        assert td["team_id"] == TEST_TEAM_ID
        assert td["user"]["name"] == TEST_USER_NAME
        assert td["user"]["id"] == TEST_USER_ID
        assert td["git_repo"] == "test/repo"
        assert td["git_url"] == "https://github.com/test/repo.git"
        assert td["git_domain"] == TEST_GIT_DOMAIN
        assert td["branch_name"] == "main"
        assert "bot" in td

        # Verify backend_url and task_token are present for MCP skill configs
        assert td["backend_url"] == TEST_BACKEND_URL
        assert td["task_token"] == TEST_AUTH_TOKEN

    @patch("app.services.execution.request_builder.settings")
    def test_task_data_user_matches_user_info(self, mock_settings: MagicMock) -> None:
        """Test that task_data['user'] matches the user_info built by the builder."""
        from app.services.execution.request_builder import TaskRequestBuilder

        mock_settings.CHAT_MCP_SERVERS = "{}"
        mock_settings.BACKEND_INTERNAL_URL = TEST_BACKEND_URL

        user = _make_user_mock()
        task = _make_task_mock()
        subtask = _make_subtask_mock()
        team = _make_team_mock()
        bot = _make_bot_mock()

        builder = TaskRequestBuilder(MagicMock())

        expected_user_info = {
            "id": TEST_USER_ID,
            "name": TEST_USER_NAME,
            "git_domain": TEST_GIT_DOMAIN,
            "git_token": TEST_GIT_TOKEN,
            "git_id": TEST_GIT_ID,
            "git_login": TEST_GIT_LOGIN,
            "git_email": TEST_GIT_EMAIL,
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
    def test_task_data_handles_no_workspace(self, mock_settings: MagicMock) -> None:
        """Test that task_data handles missing workspace gracefully."""
        from app.services.execution.request_builder import TaskRequestBuilder

        mock_settings.CHAT_MCP_SERVERS = "{}"
        mock_settings.BACKEND_INTERNAL_URL = TEST_BACKEND_URL

        user = _make_user_mock()
        task = _make_task_mock()
        subtask = _make_subtask_mock()
        team = _make_team_mock()
        bot = _make_bot_mock()

        builder = TaskRequestBuilder(MagicMock())

        builder._get_bot_for_subtask = MagicMock(return_value=bot)
        builder._build_workspace = MagicMock(return_value={})
        builder._build_user_info = MagicMock(
            return_value={"id": TEST_USER_ID, "name": TEST_USER_NAME}
        )
        builder._get_model_config = MagicMock(return_value={})
        builder._get_base_system_prompt = MagicMock(return_value="")
        builder._get_bot_skills = MagicMock(return_value=([], [], []))
        builder._build_bot_config = MagicMock(return_value=[])
        builder._build_mcp_servers = MagicMock(return_value=[])
        builder._is_group_chat = MagicMock(return_value=False)
        builder._generate_auth_token = MagicMock(return_value=TEST_AUTH_TOKEN)

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
        assert result.task_data["user"]["name"] == TEST_USER_NAME
        # backend_url and task_token should always be present
        assert result.task_data["backend_url"] == TEST_BACKEND_URL
        assert result.task_data["task_token"] == TEST_AUTH_TOKEN
