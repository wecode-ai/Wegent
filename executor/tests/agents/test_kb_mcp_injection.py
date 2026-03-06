# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests verifying KB MCP injection in ClaudeCode executor.

KB MCP is injected by the executor when knowledge_base_ids are present
and EXECUTOR_MODE is 'local'. Uses the unified knowledge MCP server
at /mcp/knowledge/sse.
"""

from unittest.mock import patch

import pytest

from shared.models.execution import ExecutionRequest


def _create_task_data(**overrides) -> ExecutionRequest:
    """Create a minimal ExecutionRequest for testing."""
    defaults = {
        "task_id": 1,
        "subtask_id": 10,
        "prompt": "Test prompt",
        "bot": [{"name": "test-bot"}],
        "backend_url": "http://localhost:8000",
        "auth_token": "test-token-123",
    }
    defaults.update(overrides)
    return ExecutionRequest(**defaults)


class TestClaudeCodeKBMCPInjection:
    """Verify executor injects KB MCP when knowledge_base_ids are present."""

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_kb_mcp_injected_when_knowledge_base_ids_present(self, mock_config):
        """KB MCP should be injected when knowledge_base_ids exist in local mode."""
        mock_config.EXECUTOR_MODE = "local"
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data(
            knowledge_base_ids=[1, 2, 3],
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        # Executor should inject wegent-knowledge (unified server)
        assert "wegent-knowledge" in mcp_servers
        kb_config = mcp_servers["wegent-knowledge"]
        assert "/mcp/knowledge/sse" in kb_config["url"]
        assert "Bearer test-token-123" in kb_config["headers"]["Authorization"]

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_no_kb_mcp_without_knowledge_base_ids(self, mock_config):
        """KB MCP should NOT be injected when no knowledge_base_ids."""
        mock_config.EXECUTOR_MODE = "local"
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data()

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        assert "wegent-knowledge" not in mcp_servers

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_backend_injected_kb_mcp_passed_through(self, mock_config):
        """KB MCP from backend (via mcp_servers in bot config) should pass through."""
        mock_config.EXECUTOR_MODE = "local"
        from executor.agents.claude_code.config_manager import extract_claude_options

        # Simulate backend-injected KB MCP in the bot's mcp_servers
        task_data = _create_task_data(
            knowledge_base_ids=[1],
            bot=[
                {
                    "name": "test-bot",
                    "mcp_servers": {
                        "wegent-knowledge": {
                            "type": "streamable-http",
                            "url": "http://localhost:8000/mcp/knowledge/sse",
                            "headers": {
                                "Authorization": "Bearer test-token-123",
                            },
                            "timeout": 300,
                        }
                    },
                }
            ],
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        # Backend-injected KB MCP should be present (passed through)
        assert "wegent-knowledge" in mcp_servers
        kb_config = mcp_servers["wegent-knowledge"]
        assert "/mcp/knowledge/sse" in kb_config["url"]
