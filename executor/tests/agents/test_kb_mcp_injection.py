# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KB retrieval MCP injection in ClaudeCode and Agno executors."""

from unittest.mock import MagicMock, patch

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
    """Tests for KB MCP injection in ClaudeCode config_manager."""

    def test_kb_mcp_injected_when_knowledge_bases_present(self):
        """Test that KB retrieval MCP server is added when knowledge_base_ids exist."""
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

    def test_kb_mcp_not_injected_when_no_knowledge_bases(self):
        """Test that KB retrieval MCP is not added when no knowledge bases."""
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data(
            knowledge_base_ids=None,
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        assert "wegent-kb-retrieval" not in mcp_servers

    def test_kb_mcp_not_injected_when_empty_knowledge_bases(self):
        """Test that KB retrieval MCP is not added when knowledge_base_ids is empty."""
        from executor.agents.claude_code.config_manager import extract_claude_options

        task_data = _create_task_data(
            knowledge_base_ids=[],
        )

        options = extract_claude_options(task_data)

        mcp_servers = options.get("mcp_servers", {})
        assert "wegent-kb-retrieval" not in mcp_servers

    def test_kb_mcp_merged_with_existing_mcp_servers(self):
        """Test that KB MCP is merged with user-configured MCP servers."""
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


class TestAgnoKBMCPInjection:
    """Tests for KB MCP injection in Agno member_builder."""

    @pytest.fixture
    def member_builder(self):
        """Create a MemberBuilder with mocked dependencies."""
        with patch("executor.agents.agno.member_builder.SqliteDb"):
            from executor.agents.agno.member_builder import MemberBuilder

            mock_db = MagicMock()
            mock_config_manager = MagicMock()
            mock_config_manager.executor_env = {}
            mock_config_manager.build_default_headers_with_placeholders.return_value = (
                {}
            )
            builder = MemberBuilder(
                db=mock_db,
                config_manager=mock_config_manager,
            )
            return builder

    @pytest.mark.anyio
    async def test_kb_mcp_tools_setup_when_kb_present(self, member_builder):
        """Test that _setup_kb_retrieval_mcp_tools connects when KBs are present."""
        task_data = _create_task_data(
            knowledge_base_ids=[1, 2],
        )

        mock_mcp_tools = MagicMock()
        mock_mcp_tools.connect = MagicMock(return_value=None)
        # Make connect a proper coroutine
        import asyncio

        async def mock_connect():
            pass

        mock_mcp_tools.connect = mock_connect

        member_builder.mcp_manager._create_streamable_http_tools = MagicMock(
            return_value=mock_mcp_tools
        )

        result = await member_builder._setup_kb_retrieval_mcp_tools(task_data)

        assert result is not None
        assert len(result) == 1
        # Verify the MCP config was created with correct URL
        call_args = member_builder.mcp_manager._create_streamable_http_tools.call_args[
            0
        ][0]
        assert call_args["url"] == "http://localhost:8000/mcp/kb-retrieval/sse"
        assert "Bearer test-token-123" in call_args["headers"]["Authorization"]

    @pytest.mark.anyio
    async def test_kb_mcp_tools_returns_none_when_no_kb(self, member_builder):
        """Test that _setup_kb_retrieval_mcp_tools returns None when no KBs."""
        task_data = _create_task_data(knowledge_base_ids=None)

        result = await member_builder._setup_kb_retrieval_mcp_tools(task_data)

        assert result is None

    @pytest.mark.anyio
    async def test_kb_mcp_tools_returns_none_when_no_backend_url(self, member_builder):
        """Test that KB MCP returns None when backend_url is missing."""
        task_data = _create_task_data(
            knowledge_base_ids=[1],
            backend_url="",
        )

        result = await member_builder._setup_kb_retrieval_mcp_tools(task_data)

        assert result is None
