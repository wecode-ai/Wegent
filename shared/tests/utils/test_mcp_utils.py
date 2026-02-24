# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

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
    task_data = {
        "backend_url": "http://localhost:8000",
        "task_token": "token-123",
    }

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert (
        replaced["wegent-knowledge"]["url"] == "http://localhost:8000/mcp/knowledge/sse"
    )
    assert (
        replaced["wegent-knowledge"]["headers"]["Authorization"] == "Bearer token-123"
    )


def test_replace_mcp_server_variables_preserves_unknown_placeholders():
    mcp_servers = {"s": {"url": "http://${{unknown}}/x"}}
    task_data = {"backend_url": "http://localhost:8000"}

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert replaced["s"]["url"] == "http://${{unknown}}/x"


def test_replace_mcp_server_variables_with_user_name_placeholder() -> None:
    """Test that ${{user.name}} placeholders are correctly replaced.

    This is a regression test for the issue where CHAT_MCP_SERVERS environment
    variable with placeholders like ${{user.name}} was not being substituted.
    """
    mcp_servers = {
        "custom-server": {
            "type": "streamable-http",
            "url": "https://api.example.com/${{user.name}}/mcp",
            "headers": {"X-User": "${{user.name}}"},
        }
    }
    task_data = {
        "user": {
            "name": "zhangsan",
            "id": 123,
        }
    }

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert replaced["custom-server"]["url"] == "https://api.example.com/zhangsan/mcp"
    assert replaced["custom-server"]["headers"]["X-User"] == "zhangsan"


def test_replace_mcp_server_variables_with_nested_user_fields() -> None:
    """Test replacement of nested user fields like ${{user.git_login}}."""
    mcp_servers = {
        "github-server": {
            "type": "streamable-http",
            "url": "https://github.com/${{user.git_login}}/mcp",
            "headers": {
                "Authorization": "Bearer ${{user.git_token}}",
                "X-Git-Email": "${{user.git_email}}",
            },
        }
    }
    task_data = {
        "user": {
            "name": "zhangsan",
            "git_login": "zhangsan_git",
            "git_token": "ghp_123456",
            "git_email": "zhangsan@example.com",
        }
    }

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert replaced["github-server"]["url"] == "https://github.com/zhangsan_git/mcp"
    assert replaced["github-server"]["headers"]["Authorization"] == "Bearer ghp_123456"
    assert replaced["github-server"]["headers"]["X-Git-Email"] == "zhangsan@example.com"


def test_replace_mcp_server_variables_with_multiple_placeholders_in_string() -> None:
    """Test replacement of multiple placeholders in a single string."""
    mcp_servers = {
        "multi-server": {
            "type": "streamable-http",
            "url": "${{backend_url}}/user/${{user.name}}/repo/${{git_repo}}",
        }
    }
    task_data = {
        "backend_url": "http://localhost:8000",
        "user": {"name": "zhangsan"},
        "git_repo": "myrepo",
    }

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert replaced["multi-server"]["url"] == "http://localhost:8000/user/zhangsan/repo/myrepo"


def test_replace_mcp_server_variables_returns_unchanged_when_task_data_is_none() -> None:
    """Test that original config is returned when task_data is None."""
    mcp_servers = {
        "test-server": {
            "url": "https://api.example.com/${{user.name}}/mcp",
        }
    }

    replaced = replace_mcp_server_variables(mcp_servers, None)

    # Should return the original unchanged
    assert replaced["test-server"]["url"] == "https://api.example.com/${{user.name}}/mcp"


def test_replace_mcp_server_variables_returns_unchanged_when_task_data_is_empty() -> None:
    """Test that original config is returned when task_data is empty dict."""
    mcp_servers = {
        "test-server": {
            "url": "https://api.example.com/${{user.name}}/mcp",
        }
    }

    replaced = replace_mcp_server_variables(mcp_servers, {})

    # Should return the original unchanged
    assert replaced["test-server"]["url"] == "https://api.example.com/${{user.name}}/mcp"


def test_replace_mcp_server_variables_handles_list_values() -> None:
    """Test that variables in list values are also replaced."""
    mcp_servers = {
        "list-server": {
            "type": "stdio",
            "command": "echo",
            "args": ["${{user.name}}", "${{backend_url}}"],
        }
    }
    task_data = {
        "user": {"name": "zhangsan"},
        "backend_url": "http://localhost:8000",
    }

    replaced = replace_mcp_server_variables(mcp_servers, task_data)

    assert replaced["list-server"]["args"] == ["zhangsan", "http://localhost:8000"]
