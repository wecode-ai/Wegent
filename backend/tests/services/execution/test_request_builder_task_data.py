# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for MCP placeholder replacement using ExecutionRequest directly.

Verifies that replace_mcp_server_variables() can accept an ExecutionRequest
object (not just a dict) and resolve ${{path}} placeholders via attribute access.
Also tests the task_token property alias on ExecutionRequest.
"""

from typing import Any

from shared.models.execution import ExecutionRequest
from shared.utils.mcp_utils import replace_mcp_server_variables

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


def _make_request(**overrides: Any) -> ExecutionRequest:
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


class TestTaskTokenProperty:
    """Tests for the task_token property alias on ExecutionRequest."""

    def test_task_token_aliases_auth_token(self) -> None:
        """task_token property should return auth_token value."""
        request = _make_request(auth_token="my-auth-token-xyz")  # noqa: S106
        assert request.task_token == "my-auth-token-xyz"

    def test_task_token_defaults_to_empty(self) -> None:
        """Default ExecutionRequest should have empty task_token."""
        request = ExecutionRequest()
        assert request.task_token == ""


class TestMcpPlaceholderWithExecutionRequest:
    """Tests that replace_mcp_server_variables() works with ExecutionRequest directly."""

    def test_user_name_placeholder_replaced(self) -> None:
        """${{user.name}} should be resolved via ExecutionRequest.user['name']."""
        mcp_servers = {
            "server": {
                "headers": {"X-User": "${{user.name}}"},
            }
        }
        request = _make_request()

        result = replace_mcp_server_variables(mcp_servers, request)

        assert result["server"]["headers"]["X-User"] == TEST_USER_NAME

    def test_top_level_fields_replaced(self) -> None:
        """Top-level attributes like task_id, git_repo should be resolved."""
        mcp_servers = {
            "server": {
                "url": "https://${{git_domain}}/api/mcp",
                "headers": {
                    "X-Task": "${{task_id}}",
                    "X-Repo": "${{git_repo}}",
                    "X-Branch": "${{branch_name}}",
                },
            }
        }
        request = _make_request()

        result = replace_mcp_server_variables(mcp_servers, request)

        assert result["server"]["url"] == f"https://{TEST_GIT_DOMAIN}/api/mcp"
        assert result["server"]["headers"]["X-Task"] == str(TEST_TASK_ID)
        assert result["server"]["headers"]["X-Repo"] == "test/repo"
        assert result["server"]["headers"]["X-Branch"] == "main"

    def test_task_token_placeholder_resolved_via_property(self) -> None:
        """${{task_token}} should resolve via the task_token property alias."""
        mcp_servers = {
            "server": {
                "url": "${{backend_url}}/mcp/sse",
                "headers": {"Authorization": "Bearer ${{task_token}}"},
            }
        }
        request = _make_request()

        result = replace_mcp_server_variables(mcp_servers, request)

        assert result["server"]["url"] == f"{TEST_BACKEND_URL}/mcp/sse"
        assert result["server"]["headers"]["Authorization"] == f"Bearer {TEST_AUTH_TOKEN}"

    def test_nested_user_git_token_replaced(self) -> None:
        """${{user.git_token}} should resolve via ExecutionRequest.user['git_token']."""
        mcp_servers = {
            "server": {
                "env": {"GIT_TOKEN": "${{user.git_token}}"},
            }
        }
        request = _make_request()

        result = replace_mcp_server_variables(mcp_servers, request)

        assert result["server"]["env"]["GIT_TOKEN"] == TEST_GIT_TOKEN  # noqa: S105

    def test_none_request_preserves_placeholders(self) -> None:
        """When task_data is None, placeholders should remain unresolved."""
        mcp_servers = {
            "server": {
                "headers": {"X-User": "${{user.name}}"},
            }
        }

        result = replace_mcp_server_variables(mcp_servers, None)

        assert result["server"]["headers"]["X-User"] == "${{user.name}}"
