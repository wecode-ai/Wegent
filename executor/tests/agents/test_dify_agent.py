# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
import json
from unittest.mock import Mock, patch, MagicMock
from executor.agents.dify.dify_agent import DifyAgent
from shared.status import TaskStatus


class TestDifyAgent:
    """Test cases for DifyAgent"""

    @pytest.fixture(autouse=True)
    def mock_http_requests(self):
        """
        Mock all HTTP requests to prevent actual network calls during tests.
        - requests.get: DifyAgent.__init__ calls _get_app_mode() which makes GET to /v1/info
        - requests.post: CallbackClient.send_callback() makes POST to callback URL
        Without these mocks, tests would make real HTTP requests causing long timeouts.
        """
        with patch('executor.agents.dify.dify_agent.requests.get') as mock_get, \
             patch('executor.callback.callback_client.requests.post') as mock_post:
            # Mock GET response for _get_app_mode()
            mock_get_response = MagicMock()
            mock_get_response.status_code = 200
            mock_get_response.json.return_value = {"mode": "chat"}
            mock_get.return_value = mock_get_response

            # Mock POST response for callback
            mock_post_response = MagicMock()
            mock_post_response.status_code = 200
            mock_post_response.content = b'{}'
            mock_post_response.json.return_value = {}
            mock_post.return_value = mock_post_response

            yield {"get": mock_get, "post": mock_post}

    @pytest.fixture
    def task_data(self):
        """Sample task data for testing"""
        return {
            "task_id": 123,
            "subtask_id": 456,
            "task_title": "Test Task",
            "subtask_title": "Test Subtask",
            "prompt": "Hello Dify",
            "bot_prompt": json.dumps({
                "difyAppId": "app-test-123",
                "params": {
                    "customer_name": "John Doe",
                    "language": "en-US"
                }
            }),
            "bot": [{
                "agent_config": {
                    "env": {
                        "DIFY_API_KEY": "app-test-api-key",
                        "DIFY_BASE_URL": "https://api.dify.ai",
                        "DIFY_APP_ID": "app-default-123"
                    }
                }
            }],
            "user": {
                "user_name": "testuser"
            }
        }

    def test_init(self, task_data):
        """Test DifyAgent initialization"""
        agent = DifyAgent(task_data)

        assert agent is not None
        assert agent.task_id == 123
        assert agent.prompt == "Hello Dify"
        assert agent.dify_app_id == "app-test-123"
        assert agent.params == {"customer_name": "John Doe", "language": "en-US"}
        assert agent.dify_config["api_key"] == "app-test-api-key"
        assert agent.dify_config["base_url"] == "https://api.dify.ai"

    def test_init_without_bot_prompt(self, task_data):
        """Test DifyAgent initialization without bot_prompt"""
        task_data["bot_prompt"] = ""
        agent = DifyAgent(task_data)

        assert agent.dify_app_id == "app-default-123"  # Should use default from config
        assert agent.params == {}

    def test_parse_bot_prompt_valid(self, task_data):
        """Test parsing valid bot_prompt"""
        agent = DifyAgent(task_data)

        app_id, params = agent._parse_bot_prompt(task_data["bot_prompt"])

        assert app_id == "app-test-123"
        assert params == {"customer_name": "John Doe", "language": "en-US"}

    def test_parse_bot_prompt_invalid_json(self, task_data):
        """Test parsing invalid JSON bot_prompt"""
        agent = DifyAgent(task_data)

        app_id, params = agent._parse_bot_prompt("invalid json")

        assert app_id is None
        assert params == {}

    def test_parse_bot_prompt_empty(self, task_data):
        """Test parsing empty bot_prompt"""
        agent = DifyAgent(task_data)

        app_id, params = agent._parse_bot_prompt("")

        assert app_id is None
        assert params == {}

    def test_validate_config_success(self, task_data):
        """Test config validation with valid config"""
        agent = DifyAgent(task_data)

        result = agent._validate_config()

        assert result is True

    def test_validate_config_missing_api_key(self, task_data):
        """Test config validation with missing API key"""
        task_data["bot"][0]["agent_config"]["env"]["DIFY_API_KEY"] = ""
        agent = DifyAgent(task_data)

        result = agent._validate_config()

        assert result is False

    def test_validate_config_missing_base_url(self, task_data):
        """Test config validation with missing base URL"""
        task_data["bot"][0]["agent_config"]["env"]["DIFY_BASE_URL"] = ""
        agent = DifyAgent(task_data)

        result = agent._validate_config()

        assert result is False

    def test_validate_config_missing_app_id(self, task_data):
        """Test config validation with missing app ID - app_id is now optional"""
        task_data["bot"][0]["agent_config"]["env"]["DIFY_APP_ID"] = ""
        task_data["bot_prompt"] = ""
        agent = DifyAgent(task_data)

        result = agent._validate_config()

        # DIFY_APP_ID is no longer required since each API key corresponds to one app
        assert result is True

    @patch('executor.agents.dify.dify_agent.requests.post')
    def test_call_dify_api_success(self, mock_post, task_data):
        """Test successful Dify API call"""
        # Mock streaming response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.iter_lines.return_value = [
            b'data: {"event": "message", "answer": "Hello", "conversation_id": "conv-123"}',
            b'data: {"event": "message", "answer": " World"}',
            b'data: {"event": "message_end"}'
        ]
        mock_post.return_value = mock_response

        agent = DifyAgent(task_data)
        result = agent._call_dify_api("Test query")

        assert result["answer"] == "Hello World"
        assert result["conversation_id"] == "conv-123"
        assert mock_post.called

    @patch('executor.agents.dify.dify_agent.requests.post')
    def test_call_dify_api_error_response(self, mock_post, task_data):
        """Test Dify API call with error response"""
        # Mock error response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.iter_lines.return_value = [
            b'data: {"event": "error", "message": "Invalid app ID"}'
        ]
        mock_post.return_value = mock_response

        agent = DifyAgent(task_data)

        with pytest.raises(Exception) as exc_info:
            agent._call_dify_api("Test query")

        assert "Dify API error" in str(exc_info.value)

    @patch('executor.agents.dify.dify_agent.requests.post')
    def test_call_dify_api_http_error(self, mock_post, task_data):
        """Test Dify API call with HTTP error"""
        # Mock HTTP error
        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_response.raise_for_status.side_effect = Exception("404 Not Found")
        mock_post.return_value = mock_response

        agent = DifyAgent(task_data)

        with pytest.raises(Exception):
            agent._call_dify_api("Test query")

    @patch.object(DifyAgent, '_call_dify_api')
    @patch.object(DifyAgent, '_validate_config')
    def test_execute_success(self, mock_validate, mock_call_api, task_data):
        """Test successful execution"""
        mock_validate.return_value = True
        mock_call_api.return_value = {
            "answer": "This is the answer from Dify",
            "conversation_id": "conv-123"
        }

        agent = DifyAgent(task_data)
        result = agent.execute()

        assert result == TaskStatus.COMPLETED
        assert mock_validate.called
        assert mock_call_api.called

    @patch.object(DifyAgent, '_validate_config')
    def test_execute_invalid_config(self, mock_validate, task_data):
        """Test execution with invalid config"""
        mock_validate.return_value = False

        agent = DifyAgent(task_data)
        result = agent.execute()

        assert result == TaskStatus.FAILED

    @patch.object(DifyAgent, '_call_dify_api')
    @patch.object(DifyAgent, '_validate_config')
    def test_execute_no_answer(self, mock_validate, mock_call_api, task_data):
        """Test execution with no answer from API"""
        mock_validate.return_value = True
        mock_call_api.return_value = {
            "answer": "",
            "conversation_id": "conv-123"
        }

        agent = DifyAgent(task_data)
        result = agent.execute()

        assert result == TaskStatus.FAILED

    @patch.object(DifyAgent, '_call_dify_api')
    @patch.object(DifyAgent, '_validate_config')
    def test_execute_api_exception(self, mock_validate, mock_call_api, task_data):
        """Test execution with API exception"""
        mock_validate.return_value = True
        mock_call_api.side_effect = Exception("API call failed")

        agent = DifyAgent(task_data)
        result = agent.execute()

        assert result == TaskStatus.FAILED

    def test_conversation_id_management(self, task_data):
        """Test conversation ID management"""
        # Clear any existing conversation state before test
        DifyAgent.clear_conversation(task_data["task_id"])

        agent = DifyAgent(task_data)

        # Initially empty
        assert agent.conversation_id == ""

        # Save conversation ID
        agent._save_conversation_id("conv-test-123")

        # Create new agent instance for same task
        agent2 = DifyAgent(task_data)
        assert agent2.conversation_id == "conv-test-123"

        # Clear conversation
        DifyAgent.clear_conversation(task_data["task_id"])
        agent3 = DifyAgent(task_data)
        assert agent3.conversation_id == ""

    def test_get_name(self, task_data):
        """Test get_name method"""
        agent = DifyAgent(task_data)

        assert agent.get_name() == "Dify"
