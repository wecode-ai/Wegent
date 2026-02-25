# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.models.execution import ExecutionRequest
from shared.utils.mcp_utils import replace_mcp_server_variables


def test_replace_mcp_server_variables_replaces_backend_url_and_task_token():
    mcp_servers = {
        "wegent-knowledge": {
            "type": "streamable-http",
            "url": "${{backend_url}}/mcp/knowledge/sse",
            "headers": {"Authorization": "Bearer ${{task_token}}"},
            "timeout": 300,
        }
    }
    task_data = ExecutionRequest(
        backend_url="http://localhost:8000",
        auth_token="test-token-",  # noqa: S106
    )

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert (
        replaced["wegent-knowledge"]["url"] == "http://localhost:8000/mcp/knowledge/sse"
    )
    assert (
        replaced["wegent-knowledge"]["headers"]["Authorization"] == "Bearer test-token-"
    )


def test_replace_mcp_server_variables_preserves_unknown_placeholders():
    mcp_servers = {"s": {"url": "http://${{unknown}}/x"}}
    task_data = ExecutionRequest(backend_url="http://localhost:8000")

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert replaced["s"]["url"] == "http://${{unknown}}/x"


def test_replace_user_name_placeholder_with_execution_request_task_data() -> None:
    """Integration test: Simulate CHAT_MCP_SERVERS with ${{user.name}} placeholder
    being resolved using an ExecutionRequest object."""
    mcp_servers = {
        "my-server": {
            "type": "sse",
            "url": "http://mcp.example.com/sse",
            "headers": {
                "X-User": "${{user.name}}",
                "X-User-Id": "${{user.id}}",
            },
        }
    }
    # ExecutionRequest structure
    task_data = ExecutionRequest(
        task_id=100,
        subtask_id=200,
        team_id=10,
        user={
            "id": 42,
            "name": "zhangsan",
            "git_domain": "github.com",
            "git_token": "ghp_token",  # noqa: S105
            "git_login": "zhangsan",
            "git_email": "zhangsan@example.com",
        },
        bot=[{"id": 5, "name": "test-bot", "shell_type": "chat"}],
        git_repo="org/repo",
        git_url="https://github.com/org/repo.git",
        git_domain="github.com",
        branch_name="main",
    )

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert replaced["my-server"]["headers"]["X-User"] == "zhangsan"
    assert replaced["my-server"]["headers"]["X-User-Id"] == "42"


def test_replace_multiple_placeholders_in_mcp_config() -> None:
    """Test that all commonly used placeholders in CHAT_MCP_SERVERS are resolved."""
    mcp_servers = {
        "git-server": {
            "type": "stdio",
            "command": "npx",
            "args": [
                "-y",
                "@mcp/git",
                "--token",
                "${{user.git_token}}",
                "--repo",
                "${{git_repo}}",
                "--branch",
                "${{branch_name}}",
            ],
            "env": {
                "GIT_TOKEN": "${{user.git_token}}",  # noqa: S105
                "GIT_DOMAIN": "${{git_domain}}",
            },
        }
    }
    task_data = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        team_id=3,
        user={
            "id": 10,
            "name": "dev",
            "git_token": "ghp_abc123",  # noqa: S105
        },
        git_repo="myorg/myrepo",
        git_domain="github.com",
        branch_name="feature/test",
        bot=[],
    )

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert replaced["git-server"]["args"][3] == "ghp_abc123"
    assert replaced["git-server"]["args"][5] == "myorg/myrepo"
    assert replaced["git-server"]["args"][7] == "feature/test"
    assert replaced["git-server"]["env"]["GIT_TOKEN"] == "ghp_abc123"  # noqa: S105
    assert replaced["git-server"]["env"]["GIT_DOMAIN"] == "github.com"


def test_replace_with_none_task_data_returns_unchanged() -> None:
    """When task_data is None (the bug scenario), placeholders remain unresolved."""
    mcp_servers = {
        "s": {
            "headers": {"X-User": "${{user.name}}"},
        }
    }

    result = replace_mcp_server_variables(mcp_servers, None)

    # Placeholders should remain because task_data is None
    assert result["s"]["headers"]["X-User"] == "${{user.name}}"
