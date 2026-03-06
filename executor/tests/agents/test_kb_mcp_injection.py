# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests verifying KB MCP injection in ClaudeCode executor.

KB MCP is injected by the executor when knowledge_base_ids are present
and EXECUTOR_MODE is 'local'. Uses the unified knowledge MCP server
at /mcp/knowledge/sse.
"""

from unittest.mock import MagicMock, patch

import pytest

from executor.agents.claude_code.session_manager import SessionManager
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
            system_prompt="Ghost prompt\n<knowledge_base>KB instructions</knowledge_base>",
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        # Executor should inject wegent-knowledge (unified server)
        assert "wegent-knowledge" in mcp_servers
        kb_config = mcp_servers["wegent-knowledge"]
        assert "/mcp/knowledge/sse" in kb_config["url"]
        assert "Bearer test-token-123" in kb_config["headers"]["Authorization"]

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_kb_system_prompt_uses_enhanced_prompt(self, mock_config):
        """System prompt should use backend's enhanced prompt with KB instructions."""
        mock_config.EXECUTOR_MODE = "local"
        from executor.agents.claude_code.config_manager import extract_claude_options

        enhanced_prompt = "Ghost prompt\n<knowledge_base>KB_PROMPT_STRICT</knowledge_base>"
        task_data = _create_task_data(
            knowledge_base_ids=[1],
            system_prompt=enhanced_prompt,
        )

        options = extract_claude_options(task_data)

        # System prompt should be the enhanced one with KB instructions
        assert options.get("system_prompt") == enhanced_prompt
        assert "<knowledge_base>" in options["system_prompt"]

    @patch("executor.agents.claude_code.config_manager.executor_config")
    def test_system_prompt_unchanged_without_kb(self, mock_config):
        """System prompt should remain the raw Ghost prompt when no KB selected."""
        mock_config.EXECUTOR_MODE = "local"
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data(
            bot=[{"name": "test-bot", "system_prompt": "Raw Ghost prompt"}],
        )

        options = extract_claude_options(task_data)

        assert options.get("system_prompt") == "Raw Ghost prompt"

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


class TestSessionManagerMCPTracking:
    """Verify SessionManager tracks MCP server keys for cached clients."""

    def setup_method(self):
        """Clean up SessionManager state before each test."""
        SessionManager._clients.clear()
        SessionManager._client_mcp_keys.clear()
        SessionManager._session_id_map.clear()

    def teardown_method(self):
        """Clean up SessionManager state after each test."""
        SessionManager._clients.clear()
        SessionManager._client_mcp_keys.clear()
        SessionManager._session_id_map.clear()

    def test_set_client_stores_mcp_keys(self):
        """set_client should store MCP server keys alongside the client."""
        mock_client = MagicMock()
        mcp_keys = frozenset(["server-a", "server-b"])

        SessionManager.set_client("session-1", mock_client, mcp_keys)

        assert SessionManager.get_client("session-1") is mock_client
        assert SessionManager.get_client_mcp_keys("session-1") == mcp_keys

    def test_set_client_default_empty_mcp_keys(self):
        """set_client with no mcp_server_keys should default to empty frozenset."""
        mock_client = MagicMock()

        SessionManager.set_client("session-1", mock_client)

        assert SessionManager.get_client_mcp_keys("session-1") == frozenset()

    def test_remove_client_cleans_mcp_keys(self):
        """remove_client should also remove MCP keys."""
        mock_client = MagicMock()
        mcp_keys = frozenset(["wegent-knowledge"])

        SessionManager.set_client("session-1", mock_client, mcp_keys)
        removed = SessionManager.remove_client("session-1")

        assert removed is mock_client
        assert SessionManager.get_client_mcp_keys("session-1") == frozenset()

    def test_get_client_mcp_keys_missing_session(self):
        """get_client_mcp_keys should return empty frozenset for unknown session."""
        assert SessionManager.get_client_mcp_keys("nonexistent") == frozenset()

    def test_mcp_keys_change_detection(self):
        """Detect MCP server config changes between cached and current options."""
        mock_client = MagicMock()
        # First message: no KB MCP
        cached_keys = frozenset(["other-server"])
        SessionManager.set_client("session-1", mock_client, cached_keys)

        # Second message: KB MCP added
        current_keys = frozenset(["other-server", "wegent-knowledge"])

        cached = SessionManager.get_client_mcp_keys("session-1")
        assert cached != current_keys  # Change detected
        assert "wegent-knowledge" not in cached
        assert "wegent-knowledge" in current_keys
