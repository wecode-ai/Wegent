# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for ExecutionRequest.to_mcp_task_data() method.

Verifies that to_mcp_task_data() correctly derives the MCP placeholder
replacement dict from ExecutionRequest attributes, without needing a
redundant task_data field.
"""

from shared.models.execution import ExecutionRequest

# Constants for test data
TEST_USER_ID = 42
TEST_USER_NAME = "testuser"
TEST_TASK_ID = 100
TEST_SUBTASK_ID = 200
TEST_TEAM_ID = 10
TEST_BOT_ID = 5
TEST_GIT_TOKEN = "ghp_test_token"  # noqa: S105
TEST_GIT_DOMAIN = "github.com"
TEST_GIT_LOGIN = "testuser"
TEST_GIT_EMAIL = "test@example.com"
TEST_GIT_ID = 12345
TEST_BACKEND_URL = "http://localhost:8000"
TEST_AUTH_TOKEN = "mock-jwt-token"  # noqa: S105

TEST_USER_INFO = {
    "id": TEST_USER_ID,
    "name": TEST_USER_NAME,
    "git_domain": TEST_GIT_DOMAIN,
    "git_token": TEST_GIT_TOKEN,
    "git_id": TEST_GIT_ID,
    "git_login": TEST_GIT_LOGIN,
    "git_email": TEST_GIT_EMAIL,
}

TEST_BOT_CONFIG = [{"id": TEST_BOT_ID, "name": "test-bot", "shell_type": "chat"}]


def _make_request(**overrides: object) -> ExecutionRequest:
    """Create an ExecutionRequest with sensible defaults for testing."""
    defaults = {
        "task_id": TEST_TASK_ID,
        "subtask_id": TEST_SUBTASK_ID,
        "team_id": TEST_TEAM_ID,
        "user": TEST_USER_INFO,
        "bot": TEST_BOT_CONFIG,
        "git_repo": "test/repo",
        "git_url": "https://github.com/test/repo.git",
        "git_domain": TEST_GIT_DOMAIN,
        "branch_name": "main",
        "backend_url": TEST_BACKEND_URL,
        "auth_token": TEST_AUTH_TOKEN,
    }
    defaults.update(overrides)
    return ExecutionRequest(**defaults)


class TestToMcpTaskData:
    """Tests for ExecutionRequest.to_mcp_task_data() method."""

    def test_returns_all_required_fields(self) -> None:
        """to_mcp_task_data() should return all fields needed for MCP placeholder replacement."""
        request = _make_request()
        td = request.to_mcp_task_data()

        assert td["task_id"] == TEST_TASK_ID
        assert td["subtask_id"] == TEST_SUBTASK_ID
        assert td["team_id"] == TEST_TEAM_ID
        assert td["user"]["name"] == TEST_USER_NAME
        assert td["user"]["id"] == TEST_USER_ID
        assert td["git_repo"] == "test/repo"
        assert td["git_url"] == "https://github.com/test/repo.git"
        assert td["git_domain"] == TEST_GIT_DOMAIN
        assert td["branch_name"] == "main"
        assert td["bot"] == TEST_BOT_CONFIG
        assert td["backend_url"] == TEST_BACKEND_URL

    def test_user_matches_request_user(self) -> None:
        """to_mcp_task_data()['user'] should be the same object as request.user."""
        request = _make_request()
        td = request.to_mcp_task_data()

        assert td["user"] is request.user

    def test_handles_none_git_fields(self) -> None:
        """When git fields are None, to_mcp_task_data() should still work."""
        request = _make_request(
            git_repo=None,
            git_url=None,
            git_domain=None,
            branch_name=None,
        )
        td = request.to_mcp_task_data()

        assert td["git_repo"] is None
        assert td["git_url"] is None
        assert td["git_domain"] is None
        assert td["branch_name"] is None
        # Other fields should still be present
        assert td["user"]["name"] == TEST_USER_NAME
        assert td["backend_url"] == TEST_BACKEND_URL

    def test_auth_token_mapped_to_task_token(self) -> None:
        """auth_token on ExecutionRequest should map to task_token in the dict."""
        request = _make_request(auth_token="my-auth-token-xyz")  # noqa: S106
        td = request.to_mcp_task_data()

        assert td["task_token"] == "my-auth-token-xyz"  # noqa: S105
        assert "auth_token" not in td

    def test_empty_auth_token_maps_to_empty_task_token(self) -> None:
        """Default empty auth_token should produce empty task_token."""
        request = ExecutionRequest()
        td = request.to_mcp_task_data()

        assert td["task_token"] == ""
