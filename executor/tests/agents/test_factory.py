# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from executor.agents.agno.agno_agent import AgnoAgent
from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.agents.dify.dify_agent import DifyAgent
from executor.agents.factory import AgentFactory


def create_mock_emitter():
    """Create a mock emitter for testing."""
    emitter = MagicMock()
    emitter.in_progress = AsyncMock()
    emitter.start = AsyncMock()
    emitter.done = AsyncMock()
    emitter.error = AsyncMock()
    emitter.text_delta = AsyncMock()
    return emitter


class TestAgentFactory:
    """Test cases for AgentFactory"""

    @pytest.fixture(autouse=True)
    def mock_http_requests(self):
        """
        Mock all HTTP requests to prevent actual network calls during tests.
        - requests.get: DifyAgent.__init__ calls _get_app_mode() which makes GET to /v1/info
        - CallbackClient: Uses TracedSession (not raw requests.post), so we mock
          the entire class to prevent retry loops with exponential backoff on empty URLs.
        """
        with (
            patch("executor.agents.dify.dify_agent.requests.get") as mock_get,
            patch("executor.agents.base.CallbackClient") as mock_callback_cls,
        ):
            # Mock GET response for _get_app_mode()
            mock_get_response = MagicMock()
            mock_get_response.status_code = 200
            mock_get_response.json.return_value = {"mode": "chat"}
            mock_get.return_value = mock_get_response

            # Mock CallbackClient instance
            mock_callback = MagicMock()
            mock_callback.send_event.return_value = {"status": "success"}
            mock_callback_cls.return_value = mock_callback

            yield {"get": mock_get, "callback": mock_callback}

    @pytest.fixture
    def mock_emitter(self):
        """Create a mock emitter for testing"""
        return create_mock_emitter()

    @pytest.fixture
    def task_data(self):
        """Sample task data for testing"""
        return {
            "task_id": 123,
            "subtask_id": 456,
            "task_title": "Test Task",
            "subtask_title": "Test Subtask",
            "user": {"user_name": "testuser"},
            "bot": [{"api_key": "test_api_key", "model": "claude-3-5-sonnet-20241022"}],
        }

    def test_get_claudecode_agent(self, task_data, mock_emitter):
        """Test creating ClaudeCode agent"""
        agent = AgentFactory.get_agent("claudecode", task_data, mock_emitter)

        assert agent is not None
        assert isinstance(agent, ClaudeCodeAgent)
        assert agent.task_id == task_data["task_id"]

    def test_get_claudecode_agent_case_insensitive(self, task_data, mock_emitter):
        """Test creating ClaudeCode agent with different case"""
        agent = AgentFactory.get_agent("ClaudeCode", task_data, mock_emitter)

        assert agent is not None
        assert isinstance(agent, ClaudeCodeAgent)

    def test_get_agno_agent(self, task_data, mock_emitter):
        """Test creating Agno agent"""
        agent = AgentFactory.get_agent("agno", task_data, mock_emitter)

        assert agent is not None
        assert isinstance(agent, AgnoAgent)
        assert agent.task_id == task_data["task_id"]

    def test_get_agno_agent_case_insensitive(self, task_data, mock_emitter):
        """Test creating Agno agent with different case"""
        agent = AgentFactory.get_agent("AGNO", task_data, mock_emitter)

        assert agent is not None
        assert isinstance(agent, AgnoAgent)

    def test_get_dify_agent(self, task_data, mock_emitter):
        """Test creating Dify agent"""
        agent = AgentFactory.get_agent("dify", task_data, mock_emitter)

        assert agent is not None
        assert isinstance(agent, DifyAgent)
        assert agent.task_id == task_data["task_id"]

    def test_get_dify_agent_case_insensitive(self, task_data, mock_emitter):
        """Test creating Dify agent with different case"""
        agent = AgentFactory.get_agent("DIFY", task_data, mock_emitter)

        assert agent is not None
        assert isinstance(agent, DifyAgent)

    def test_get_unsupported_agent(self, task_data, mock_emitter):
        """Test creating unsupported agent type"""
        agent = AgentFactory.get_agent("unsupported_type", task_data, mock_emitter)

        assert agent is None

    def test_get_empty_agent_type(self, task_data, mock_emitter):
        """Test creating agent with empty type"""
        agent = AgentFactory.get_agent("", task_data, mock_emitter)

        assert agent is None

    def test_agents_registry(self):
        """Test that agents registry contains expected agents"""
        assert "claudecode" in AgentFactory._agents
        assert "agno" in AgentFactory._agents
        assert "dify" in AgentFactory._agents
        assert AgentFactory._agents["claudecode"] == ClaudeCodeAgent
        assert AgentFactory._agents["agno"] == AgnoAgent
        assert AgentFactory._agents["dify"] == DifyAgent
