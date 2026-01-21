# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, Mock, patch

import pytest

from executor.agents.base import Agent
from shared.status import TaskStatus


class TestAgent:
    """Test cases for the base Agent class"""

    @pytest.fixture
    def task_data(self):
        """Sample task data for testing"""
        return {
            "task_id": 123,
            "subtask_id": 456,
            "task_title": "Test Task",
            "subtask_title": "Test Subtask",
            "git_url": "https://github.com/test/repo.git",
            "branch_name": "main",
            "user": {
                "user_name": "testuser",
                "git_token": "test_token",
                "git_id": "12345",
                "git_login": "testuser",
                "git_email": "test@example.com",
            },
        }

    @pytest.fixture
    def agent(self, task_data):
        """Create a test agent instance"""
        return Agent(task_data)

    def test_agent_initialization(self, agent, task_data):
        """Test agent initialization with task data"""
        assert agent.task_id == task_data["task_id"]
        assert agent.subtask_id == task_data["subtask_id"]
        assert agent.task_title == task_data["task_title"]
        assert agent.subtask_title == task_data["subtask_title"]
        assert agent.execution_status == TaskStatus.INITIALIZED
        assert agent.project_path is None

    def test_get_name(self, agent):
        """Test get_name returns class name"""
        assert agent.get_name() == "Agent"

    def test_pre_execute_default(self, agent):
        """Test default pre_execute returns SUCCESS"""
        status = agent.pre_execute()
        assert status == TaskStatus.SUCCESS

    def test_execute_not_implemented(self, agent):
        """Test execute raises NotImplementedError"""
        with pytest.raises(NotImplementedError):
            agent.execute()

    def test_initialize_default(self, agent):
        """Test default initialize returns SUCCESS"""
        status = agent.initialize()
        assert status == TaskStatus.SUCCESS

    @patch("executor.agents.base.CallbackClient")
    def test_report_progress(self, mock_callback_class, agent):
        """Test report_progress sends callback"""
        mock_callback = MagicMock()
        mock_callback_class.return_value = mock_callback

        # Create new agent to use mocked callback
        agent_with_mock = Agent(agent.task_data)

        agent_with_mock.report_progress(
            progress=50,
            status="running",
            message="Test message",
            result={"key": "value"},
        )

        mock_callback.send_callback.assert_called_once()

    @patch("executor.agents.base.git_util.clone_repo")
    @patch("executor.agents.base.git_util.get_repo_name_from_url")
    @patch("os.path.exists")
    def test_download_code_success(
        self, mock_exists, mock_get_repo_name, mock_clone, agent
    ):
        """Test successful code download"""
        mock_exists.return_value = False
        mock_get_repo_name.return_value = "repo"
        mock_clone.return_value = (True, None)

        with patch.object(agent, "setup_git_config"):
            agent.download_code()

        mock_clone.assert_called_once()
        assert agent.project_path is not None

    @patch("executor.agents.base.git_util.get_repo_name_from_url")
    @patch("os.path.exists")
    def test_download_code_already_exists(self, mock_exists, mock_get_repo_name, agent):
        """Test code download when project already exists"""
        mock_exists.return_value = True
        mock_get_repo_name.return_value = "repo"

        agent.download_code()

        # Should not raise exception
        assert True

    def test_download_code_empty_git_url(self, agent):
        """Test download_code with empty git_url"""
        agent.task_data["git_url"] = ""
        agent.download_code()
        # Should not raise exception
        assert True

    @patch("executor.agents.base.git_util.set_git_config")
    def test_setup_git_config(self, mock_set_config, agent):
        """Test git config setup"""
        mock_set_config.return_value = (True, None)
        user_config = agent.task_data["user"]
        project_path = "/test/path"

        agent.setup_git_config(user_config, project_path)

        mock_set_config.assert_called_once_with(
            project_path, user_config["git_login"], user_config["git_email"]
        )

    @patch("executor.agents.base.git_util.set_git_config")
    def test_setup_git_config_no_email(self, mock_set_config, agent):
        """Test git config setup without email"""
        mock_set_config.return_value = (True, None)
        user_config = {"git_id": "12345", "git_login": "testuser"}
        project_path = "/test/path"

        agent.setup_git_config(user_config, project_path)

        # Should generate email from git_id and git_login
        expected_email = "12345+testuser@users.noreply.github.com"
        mock_set_config.assert_called_once_with(
            project_path, "testuser", expected_email
        )

    def test_record_error_thinking_without_capability(self, agent):
        """Test _record_error_thinking when capability is not available"""
        # Should not raise exception
        agent._record_error_thinking("Test Error", "Error message")
        assert True

    def test_record_error_thinking_with_capability(self, agent):
        """Test _record_error_thinking when capability is available"""
        agent.add_thinking_step = MagicMock()

        agent._record_error_thinking("Test Error", "Error message")

        agent.add_thinking_step.assert_called_once()


class ConcreteAgent(Agent):
    """Concrete implementation of Agent for testing handle method"""

    def execute(self):
        return TaskStatus.SUCCESS


class TestAgentHandle:
    """Test cases for Agent.handle method"""

    @pytest.fixture
    def task_data(self):
        return {
            "task_id": 123,
            "subtask_id": 456,
            "task_title": "Test Task",
            "subtask_title": "Test Subtask",
        }

    @pytest.fixture
    def concrete_agent(self, task_data):
        return ConcreteAgent(task_data)

    def test_handle_success(self, concrete_agent):
        """Test successful handle execution"""
        status, error = concrete_agent.handle()

        assert status == TaskStatus.SUCCESS
        assert error is None

    def test_handle_with_pre_executed_status(self, concrete_agent):
        """Test handle with pre_executed parameter"""
        status, error = concrete_agent.handle(pre_executed=TaskStatus.PRE_EXECUTED)

        assert status == TaskStatus.SUCCESS
        assert error is None
        assert concrete_agent.execution_status == TaskStatus.RUNNING

    def test_handle_pre_execute_failure(self, concrete_agent):
        """Test handle when pre_execute fails"""
        with patch.object(
            concrete_agent, "pre_execute", return_value=TaskStatus.FAILED
        ):
            status, error = concrete_agent.handle()

        assert status == TaskStatus.FAILED
        assert error is not None

    def test_handle_execute_exception(self, concrete_agent):
        """Test handle when execute raises exception"""
        with patch.object(
            concrete_agent, "execute", side_effect=Exception("Test error")
        ):
            status, error = concrete_agent.handle(pre_executed=TaskStatus.PRE_EXECUTED)

        assert status == TaskStatus.FAILED
        assert error is not None
        assert "Test error" in error
