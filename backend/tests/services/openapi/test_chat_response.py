# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for OpenAPI chat_response module.

Tests cover both HTTP and Package modes based on CHAT_SHELL_MODE configuration.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestChatResponseModeRouting:
    """Test that chat_response routes to HTTP or Package mode correctly."""

    @pytest.mark.asyncio
    async def test_streaming_routes_to_http_mode(self):
        """Test create_streaming_response routes to HTTP mode when CHAT_SHELL_MODE=http."""
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.CHAT_SHELL_MODE = "http"

            with patch(
                "app.services.openapi.chat_response._create_streaming_response_http"
            ) as mock_http:
                mock_http.return_value = MagicMock()

                from app.services.openapi.chat_response import create_streaming_response

                # Call the function - it should route to HTTP handler
                await create_streaming_response(
                    db=MagicMock(),
                    user=MagicMock(),
                    team=MagicMock(),
                    model_info={},
                    request_body=MagicMock(),
                    input_text="test",
                    tool_settings={},
                )

                mock_http.assert_called_once()

    @pytest.mark.asyncio
    async def test_streaming_routes_to_package_mode(self):
        """Test create_streaming_response routes to Package mode when CHAT_SHELL_MODE=package."""
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.CHAT_SHELL_MODE = "package"

            with patch(
                "app.services.openapi.chat_response._create_streaming_response_package"
            ) as mock_package:
                mock_package.return_value = MagicMock()

                from app.services.openapi.chat_response import create_streaming_response

                await create_streaming_response(
                    db=MagicMock(),
                    user=MagicMock(),
                    team=MagicMock(),
                    model_info={},
                    request_body=MagicMock(),
                    input_text="test",
                    tool_settings={},
                )

                mock_package.assert_called_once()

    @pytest.mark.asyncio
    async def test_sync_routes_to_http_mode(self):
        """Test create_sync_response routes to HTTP mode when CHAT_SHELL_MODE=http."""
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.CHAT_SHELL_MODE = "http"

            with patch(
                "app.services.openapi.chat_response._create_sync_response_http"
            ) as mock_http:
                mock_http.return_value = MagicMock()

                from app.services.openapi.chat_response import create_sync_response

                await create_sync_response(
                    db=MagicMock(),
                    user=MagicMock(),
                    team=MagicMock(),
                    model_info={},
                    request_body=MagicMock(),
                    input_text="test",
                    tool_settings={},
                )

                mock_http.assert_called_once()

    @pytest.mark.asyncio
    async def test_sync_routes_to_package_mode(self):
        """Test create_sync_response routes to Package mode when CHAT_SHELL_MODE=package."""
        with patch("app.core.config.settings") as mock_settings:
            mock_settings.CHAT_SHELL_MODE = "package"

            with patch(
                "app.services.openapi.chat_response._create_sync_response_package"
            ) as mock_package:
                mock_package.return_value = MagicMock()

                from app.services.openapi.chat_response import create_sync_response

                await create_sync_response(
                    db=MagicMock(),
                    user=MagicMock(),
                    team=MagicMock(),
                    model_info={},
                    request_body=MagicMock(),
                    input_text="test",
                    tool_settings={},
                )

                mock_package.assert_called_once()


class TestHTTPAdapterIntegration:
    """Tests for HTTP adapter integration with chat_response."""

    @pytest.mark.asyncio
    async def test_http_sync_creates_chat_request_correctly(self):
        """Test HTTP sync mode creates ChatRequest with correct parameters."""
        from app.services.chat.adapters.interface import ChatEvent, ChatEventType

        with patch("app.core.config.settings") as mock_settings:
            mock_settings.CHAT_SHELL_MODE = "http"
            mock_settings.CHAT_SHELL_URL = "http://localhost:8100"
            mock_settings.CHAT_SHELL_TOKEN = "test-token"
            mock_settings.WEB_SEARCH_ENABLED = False

            with (
                patch(
                    "app.services.openapi.chat_response.setup_chat_session"
                ) as mock_setup_session,
                patch(
                    "app.services.openapi.chat_response.build_chat_history"
                ) as mock_build_history,
                patch(
                    "app.services.chat.adapters.http.HTTPAdapter"
                ) as mock_adapter_class,
                patch("app.services.chat.storage.db_handler") as mock_db_handler,
                patch(
                    "app.services.chat.storage.session_manager"
                ) as mock_session_manager,
            ):
                # Setup mock session with complete task json
                mock_task = MagicMock()
                mock_task.json = {
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Task",
                    "metadata": {"name": "test-task", "namespace": "default"},
                    "spec": {
                        "title": "Test",
                        "prompt": "Hello",
                        "teamRef": {"name": "test-team", "namespace": "default"},
                        "workspaceRef": {"name": "workspace-1", "namespace": "default"},
                    },
                    "status": {"status": "RUNNING"},
                }

                mock_setup = MagicMock()
                mock_setup.task_id = 1
                mock_setup.assistant_subtask = MagicMock(id=2)
                mock_setup.system_prompt = "test prompt"
                mock_setup.model_config = {"model_id": "gpt-4", "model": "openai"}
                mock_setup.bot_name = "test-bot"
                mock_setup.bot_namespace = "default"
                mock_setup.existing_subtasks = []
                mock_setup.task = mock_task
                mock_setup_session.return_value = mock_setup

                mock_build_history.return_value = []

                # Setup mock adapter to yield chunks
                mock_adapter = MagicMock()
                captured_request = None

                async def mock_chat(request):
                    nonlocal captured_request
                    captured_request = request
                    yield ChatEvent(type=ChatEventType.CHUNK, data={"content": "Hello"})
                    yield ChatEvent(type=ChatEventType.DONE, data={})

                mock_adapter.chat = mock_chat
                mock_adapter_class.return_value = mock_adapter

                mock_db_handler.update_subtask_status = AsyncMock()
                mock_session_manager.append_user_and_assistant_messages = AsyncMock()

                from app.services.openapi.chat_response import (
                    _create_sync_response_http,
                )

                mock_user = MagicMock()
                mock_user.id = 1
                mock_user.user_name = "testuser"

                mock_request = MagicMock()
                mock_request.model = "default#test-team"
                mock_request.previous_response_id = None

                mock_db = MagicMock()

                response = await _create_sync_response_http(
                    db=mock_db,
                    user=mock_user,
                    team=MagicMock(id=1, name="test-team"),
                    model_info={},
                    request_body=mock_request,
                    input_text="Hi there",
                    tool_settings={"enable_chat_bot": True},
                )

                # Verify ChatRequest was created correctly
                assert captured_request is not None
                assert captured_request.task_id == 1
                assert captured_request.subtask_id == 2
                assert captured_request.message == "Hi there"
                assert captured_request.user_id == 1
                assert captured_request.user_name == "testuser"

    @pytest.mark.asyncio
    async def test_http_sync_handles_error_correctly(self):
        """Test HTTP sync mode handles error events correctly."""
        from fastapi import HTTPException

        from app.services.chat.adapters.interface import ChatEvent, ChatEventType

        with patch("app.core.config.settings") as mock_settings:
            mock_settings.CHAT_SHELL_MODE = "http"
            mock_settings.CHAT_SHELL_URL = "http://localhost:8100"
            mock_settings.CHAT_SHELL_TOKEN = "test-token"
            mock_settings.WEB_SEARCH_ENABLED = False

            with (
                patch(
                    "app.services.openapi.chat_response.setup_chat_session"
                ) as mock_setup_session,
                patch(
                    "app.services.openapi.chat_response.build_chat_history"
                ) as mock_build_history,
                patch(
                    "app.services.chat.adapters.http.HTTPAdapter"
                ) as mock_adapter_class,
                patch("app.services.chat.storage.db_handler") as mock_db_handler,
                patch(
                    "app.services.chat.storage.session_manager"
                ) as mock_session_manager,
            ):
                # Setup mock session with complete task json
                mock_task = MagicMock()
                mock_task.json = {
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Task",
                    "metadata": {"name": "test-task", "namespace": "default"},
                    "spec": {
                        "title": "Test",
                        "prompt": "Hello",
                        "teamRef": {"name": "test-team", "namespace": "default"},
                        "workspaceRef": {"name": "workspace-1", "namespace": "default"},
                    },
                    "status": {"status": "RUNNING"},
                }

                mock_setup = MagicMock()
                mock_setup.task_id = 1
                mock_setup.assistant_subtask = MagicMock(id=2)
                mock_setup.system_prompt = "test prompt"
                mock_setup.model_config = {}
                mock_setup.bot_name = "test-bot"
                mock_setup.bot_namespace = "default"
                mock_setup.existing_subtasks = []
                mock_setup.task = mock_task
                mock_setup_session.return_value = mock_setup

                mock_build_history.return_value = []

                # Setup mock adapter to yield error
                mock_adapter = MagicMock()

                async def mock_chat(request):
                    yield ChatEvent(
                        type=ChatEventType.ERROR,
                        data={"error": "Model not available"},
                    )

                mock_adapter.chat = mock_chat
                mock_adapter_class.return_value = mock_adapter

                mock_db_handler.update_subtask_status = AsyncMock()
                mock_session_manager.append_user_and_assistant_messages = AsyncMock()

                from app.services.openapi.chat_response import (
                    _create_sync_response_http,
                )

                mock_user = MagicMock()
                mock_user.id = 1
                mock_user.user_name = "testuser"

                mock_request = MagicMock()
                mock_request.model = "default#test-team"
                mock_request.previous_response_id = None

                mock_db = MagicMock()

                with pytest.raises(HTTPException) as exc_info:
                    await _create_sync_response_http(
                        db=mock_db,
                        user=mock_user,
                        team=MagicMock(id=1, name="test-team"),
                        model_info={},
                        request_body=mock_request,
                        input_text="Hi",
                        tool_settings={},
                    )

                assert exc_info.value.status_code == 500
                assert "Model not available" in exc_info.value.detail


class TestBuildChatHistory:
    """Tests for build_chat_history helper function."""

    def test_build_chat_history_empty(self):
        """Test building history from empty subtasks."""
        from app.services.openapi.chat_session import build_chat_history

        result = build_chat_history([])
        assert result == []

    def test_build_chat_history_with_messages(self):
        """Test building history from subtasks."""
        from app.models.subtask import SubtaskRole, SubtaskStatus
        from app.services.openapi.chat_session import build_chat_history

        mock_user_subtask = MagicMock()
        mock_user_subtask.role = SubtaskRole.USER
        mock_user_subtask.prompt = "Hello"
        mock_user_subtask.message_id = 1
        mock_user_subtask.status = SubtaskStatus.COMPLETED

        mock_assistant_subtask = MagicMock()
        mock_assistant_subtask.role = SubtaskRole.ASSISTANT
        mock_assistant_subtask.result = {"value": "Hi there!"}
        mock_assistant_subtask.message_id = 2
        mock_assistant_subtask.status = SubtaskStatus.COMPLETED

        result = build_chat_history([mock_user_subtask, mock_assistant_subtask])

        assert len(result) == 2
        assert result[0]["role"] == "user"
        assert result[0]["content"] == "Hello"
        assert result[1]["role"] == "assistant"
        assert result[1]["content"] == "Hi there!"

    def test_build_chat_history_filters_assistant_without_result(self):
        """Test that assistant messages without result are skipped."""
        from app.models.subtask import SubtaskRole, SubtaskStatus
        from app.services.openapi.chat_session import build_chat_history

        mock_user_subtask = MagicMock()
        mock_user_subtask.role = SubtaskRole.USER
        mock_user_subtask.prompt = "Hello"
        mock_user_subtask.message_id = 1
        mock_user_subtask.status = SubtaskStatus.COMPLETED

        mock_assistant_subtask = MagicMock()
        mock_assistant_subtask.role = SubtaskRole.ASSISTANT
        mock_assistant_subtask.result = None  # No result
        mock_assistant_subtask.message_id = 2
        mock_assistant_subtask.status = SubtaskStatus.COMPLETED

        result = build_chat_history([mock_user_subtask, mock_assistant_subtask])

        # Only user message should be included
        assert len(result) == 1
        assert result[0]["role"] == "user"
