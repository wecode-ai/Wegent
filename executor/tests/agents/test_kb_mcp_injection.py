# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KB retrieval MCP injection in ClaudeCode executor (local mode only)."""

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
    """Tests for KB MCP injection in ClaudeCode config_manager (local mode only)."""

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_kb_mcp_injected_in_local_mode(self, mock_config):
        """Test that KB retrieval MCP server is added in local mode."""
        mock_config.EXECUTOR_MODE = "local"
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data(
            knowledge_base_ids=[1, 2, 3],
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        assert "wegent-kb-retrieval" in mcp_servers
        kb_config = mcp_servers["wegent-kb-retrieval"]
        assert kb_config["type"] == "http"
        assert "/mcp/kb-retrieval/sse" in kb_config["url"]
        assert "Bearer test-token-123" in kb_config["headers"]["Authorization"]
        assert kb_config["timeout"] == 300

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_kb_mcp_not_injected_in_docker_mode(self, mock_config):
        """Test that KB retrieval MCP server is NOT added in docker mode."""
        mock_config.EXECUTOR_MODE = "docker"
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data(
            knowledge_base_ids=[1, 2, 3],
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        assert "wegent-kb-retrieval" not in mcp_servers

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_kb_mcp_not_injected_when_no_knowledge_bases(self, mock_config):
        """Test that KB retrieval MCP is not added when no knowledge bases."""
        mock_config.EXECUTOR_MODE = "local"
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data(
            knowledge_base_ids=None,
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        assert "wegent-kb-retrieval" not in mcp_servers

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_kb_mcp_not_injected_when_empty_knowledge_bases(self, mock_config):
        """Test that KB retrieval MCP is not added when knowledge_base_ids is empty."""
        mock_config.EXECUTOR_MODE = "local"
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data(
            knowledge_base_ids=[],
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        assert "wegent-kb-retrieval" not in mcp_servers

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_kb_mcp_merged_with_existing_mcp_servers(self, mock_config):
        """Test that KB MCP is merged with user-configured MCP servers."""
        mock_config.EXECUTOR_MODE = "local"
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data(
            knowledge_base_ids=[1],
            bot=[
                {
                    "name": "test-bot",
                    "mcp_servers": {
                        "user-mcp": {
                            "type": "streamable-http",
                            "url": "http://user-mcp.example.com",
                        }
                    },
                }
            ],
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        # Both user MCP and KB retrieval MCP should be present
        assert "user-mcp" in mcp_servers
        assert "wegent-kb-retrieval" in mcp_servers
