# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from executor.agents.factory import AgentFactory
from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.agents.agno.agno_agent import AgnoAgent
from executor.agents.dify.dify_agent import DifyAgent


class TestAgentFactory:
    """Test cases for AgentFactory"""

    @pytest.fixture
    def task_data(self):
        """Sample task data for testing"""
        return {
            "task_id": 123,
            "subtask_id": 456,
            "task_title": "Test Task",
            "subtask_title": "Test Subtask",
            "user": {
                "user_name": "testuser"
            },
            "bot": [{
                "api_key": "test_api_key",
                "model": "claude-3-5-sonnet-20241022"
            }]
        }

    def test_get_claudecode_agent(self, task_data):
        """Test creating ClaudeCode agent"""
        agent = AgentFactory.get_agent("claudecode", task_data)

        assert agent is not None
        assert isinstance(agent, ClaudeCodeAgent)
        assert agent.task_id == task_data["task_id"]

    def test_get_claudecode_agent_case_insensitive(self, task_data):
        """Test creating ClaudeCode agent with different case"""
        agent = AgentFactory.get_agent("ClaudeCode", task_data)

        assert agent is not None
        assert isinstance(agent, ClaudeCodeAgent)

    def test_get_agno_agent(self, task_data):
        """Test creating Agno agent"""
        agent = AgentFactory.get_agent("agno", task_data)

        assert agent is not None
        assert isinstance(agent, AgnoAgent)
        assert agent.task_id == task_data["task_id"]

    def test_get_agno_agent_case_insensitive(self, task_data):
        """Test creating Agno agent with different case"""
        agent = AgentFactory.get_agent("AGNO", task_data)

        assert agent is not None
        assert isinstance(agent, AgnoAgent)

    def test_get_dify_agent(self, task_data):
        """Test creating Dify agent"""
        agent = AgentFactory.get_agent("dify", task_data)

        assert agent is not None
        assert isinstance(agent, DifyAgent)
        assert agent.task_id == task_data["task_id"]

    def test_get_dify_agent_case_insensitive(self, task_data):
        """Test creating Dify agent with different case"""
        agent = AgentFactory.get_agent("DIFY", task_data)

        assert agent is not None
        assert isinstance(agent, DifyAgent)

    def test_get_unsupported_agent(self, task_data):
        """Test creating unsupported agent type"""
        agent = AgentFactory.get_agent("unsupported_type", task_data)

        assert agent is None

    def test_get_empty_agent_type(self, task_data):
        """Test creating agent with empty type"""
        agent = AgentFactory.get_agent("", task_data)

        assert agent is None

    def test_agents_registry(self):
        """Test that agents registry contains expected agents"""
        assert "claudecode" in AgentFactory._agents
        assert "agno" in AgentFactory._agents
        assert "dify" in AgentFactory._agents
        assert AgentFactory._agents["claudecode"] == ClaudeCodeAgent
        assert AgentFactory._agents["agno"] == AgnoAgent
        assert AgentFactory._agents["dify"] == DifyAgent
