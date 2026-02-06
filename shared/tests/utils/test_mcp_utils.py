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
