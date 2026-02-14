# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for create_chat_task function.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.chat.storage import TaskCreationParams, TaskCreationResult


class TestTaskCreationParams:
    """Test TaskCreationParams dataclass."""

    def test_required_fields(self):
        """Test TaskCreationParams with required fields only."""
        params = TaskCreationParams(
            message="Hello",
            title="Test Task",
        )

        assert params.message == "Hello"
        assert params.title == "Test Task"
        assert params.model_id is None
        assert params.force_override_bot_model is False
        assert params.is_group_chat is False
        assert params.git_url is None

    def test_all_fields(self):
        """Test TaskCreationParams with all fields."""
        params = TaskCreationParams(
            message="Hello",
            title="Test Task",
            model_id="gpt-4",
            force_override_bot_model=True,
            is_group_chat=True,
            git_url="https://github.com/test/repo",
            git_repo="test/repo",
            git_repo_id=123,
            git_domain="github.com",
            branch_name="main",
        )

        assert params.message == "Hello"
        assert params.title == "Test Task"
        assert params.model_id == "gpt-4"
        assert params.force_override_bot_model is True
        assert params.is_group_chat is True
        assert params.git_url == "https://github.com/test/repo"
        assert params.git_repo == "test/repo"
        assert params.git_repo_id == 123
        assert params.git_domain == "github.com"
        assert params.branch_name == "main"


class TestTaskCreationResult:
    """Test TaskCreationResult dataclass."""

    def test_with_all_subtasks(self):
        """Test TaskCreationResult with all subtasks present."""
        mock_task = MagicMock()
        mock_task.id = 1

        mock_user_subtask = MagicMock()
        mock_user_subtask.id = 2

        mock_assistant_subtask = MagicMock()
        mock_assistant_subtask.id = 3

        result = TaskCreationResult(
            task=mock_task,
            user_subtask=mock_user_subtask,
            assistant_subtask=mock_assistant_subtask,
            ai_triggered=True,
            rag_prompt="Enhanced prompt",
        )

        assert result.task.id == 1
        assert result.user_subtask.id == 2
        assert result.assistant_subtask.id == 3
        assert result.ai_triggered is True
        assert result.rag_prompt == "Enhanced prompt"

    def test_without_assistant_subtask(self):
        """Test TaskCreationResult without assistant subtask (AI not triggered)."""
        mock_task = MagicMock()
        mock_task.id = 1

        mock_user_subtask = MagicMock()
        mock_user_subtask.id = 2

        result = TaskCreationResult(
            task=mock_task,
            user_subtask=mock_user_subtask,
            assistant_subtask=None,
            ai_triggered=False,
            rag_prompt=None,
        )

        assert result.task.id == 1
        assert result.user_subtask.id == 2
        assert result.assistant_subtask is None
        assert result.ai_triggered is False
        assert result.rag_prompt is None


class TestCreateChatTaskRouting:
    """Test create_chat_task routing logic.

    NOTE: After the unified execution architecture refactor, all tasks go through
    the same path. ExecutionDispatcher automatically routes based on shell_type.
    The should_use_direct_chat function has been removed.
    """

    @pytest.mark.asyncio
    async def test_unified_path_routing(self):
        """Test that create_chat_task uses unified path (create_task_and_subtasks).

        After the unified execution architecture refactor, all tasks go through
        the same path. ExecutionDispatcher automatically routes based on shell_type.
        """
        from app.services.chat.storage.task_manager import create_chat_task

        # Mock dependencies
        mock_db = MagicMock()
        mock_user = MagicMock()
        mock_user.id = 1
        mock_team = MagicMock()
        mock_team.id = 1
        mock_team.name = "test-team"
        mock_team.namespace = "default"

        params = TaskCreationParams(
            message="Test message",
            title="Test Task",
        )

        mock_result = TaskCreationResult(
            task=MagicMock(id=100),
            user_subtask=MagicMock(id=200),
            assistant_subtask=MagicMock(id=300),
            ai_triggered=True,
            rag_prompt=None,
        )

        with patch(
            "app.services.chat.storage.task_manager.create_task_and_subtasks",
            new_callable=AsyncMock,
            return_value=mock_result,
        ) as mock_create_task:
            result = await create_chat_task(
                db=mock_db,
                user=mock_user,
                team=mock_team,
                message="Test message",
                params=params,
                should_trigger_ai=True,
            )

            # Verify create_task_and_subtasks was called (unified path)
            mock_create_task.assert_called_once()
            assert result.task.id == 100
            assert result.ai_triggered is True
