# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

chat_shell_module = ModuleType("chat_shell")
chat_shell_models_module = ModuleType("chat_shell.models")
chat_shell_models_module.LangChainModelFactory = object
chat_shell_module.models = chat_shell_models_module
sys.modules.setdefault("chat_shell", chat_shell_module)
sys.modules.setdefault("chat_shell.models", chat_shell_models_module)
chat_config_module = ModuleType("app.services.chat.config")
chat_config_module.get_team_first_bot_shell_type = Mock()
sys.modules.setdefault("app.services.chat.config", chat_config_module)

from app.api.ws.chat_namespace import ChatNamespace


class _RetryDbMock:
    """Mock DB that records whether the retry session was released."""

    def __init__(self, user):
        self.closed = False
        self.rolled_back = False
        self.commit = Mock()
        self.query = Mock()
        self.query.return_value.filter.return_value.first.return_value = user

    def close(self):
        self.closed = True

    def rollback(self):
        self.rolled_back = True


@pytest.mark.asyncio
async def test_chat_retry_default_model_clears_stale_override_labels_without_name_error():
    """Retrying with the bot default model should clear stale labels and succeed."""

    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace._check_token_expiry = AsyncMock(return_value=False)

    task = SimpleNamespace(
        id=100,
        json={
            "metadata": {
                "labels": {
                    "modelId": "old-model",
                    "forceOverrideBotModel": "true",
                    "forceOverrideBotModelType": "public",
                }
            }
        },
    )
    failed_ai_subtask = SimpleNamespace(
        id=42,
        team_id=10,
        message_id=7,
        parent_id=41,
        status=SimpleNamespace(value="FAILED"),
    )
    team = SimpleNamespace(id=10)
    user_subtask = SimpleNamespace(id=41, prompt="Hello", contexts=[])
    user = SimpleNamespace(id=1)

    db = Mock()
    db.query.return_value.filter.return_value.first.return_value = user

    with (
        patch("app.api.ws.chat_namespace.SessionLocal", return_value=db),
        patch(
            "app.api.ws.chat_namespace.can_access_task", AsyncMock(return_value=True)
        ),
        patch(
            "app.api.ws.chat_namespace.fetch_retry_context",
            return_value=(failed_ai_subtask, task, team, user_subtask),
        ),
        patch("app.api.ws.chat_namespace.reset_subtask_for_retry"),
        patch("app.api.ws.chat_namespace.extract_display_prompt", return_value="Hello"),
        patch("app.api.ws.chat_namespace.get_device_id", return_value=None),
        patch(
            "app.api.ws.chat_namespace.trigger_ai_response_unified",
            AsyncMock(),
        ) as mock_trigger,
        patch("sqlalchemy.orm.attributes.flag_modified") as mock_flag_modified,
    ):
        result = await namespace.on_chat_retry(
            "sid-123",
            {
                "task_id": 100,
                "subtask_id": 42,
                "force_override_bot_model": None,
                "force_override_bot_model_type": None,
                "use_model_override": True,
            },
        )

    assert result == {"success": True}
    assert task.json["metadata"]["labels"] == {}
    mock_flag_modified.assert_called_once_with(task, "json")
    assert db.commit.called
    assert mock_trigger.await_count == 1
    assert mock_trigger.await_args.kwargs["payload"].force_override_bot_model is None


@pytest.mark.asyncio
async def test_chat_retry_closes_session_before_triggering_sse_dispatch():
    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace._check_token_expiry = AsyncMock(return_value=False)

    task = SimpleNamespace(id=100, json={"metadata": {"labels": {}}})
    failed_ai_subtask = SimpleNamespace(
        id=42,
        team_id=10,
        message_id=7,
        parent_id=41,
        status=SimpleNamespace(value="FAILED"),
    )
    team = SimpleNamespace(id=10)
    user_subtask = SimpleNamespace(id=41, prompt="Hello", contexts=[])
    user = SimpleNamespace(id=1)
    db = _RetryDbMock(user=user)

    async def assert_session_closed_before_dispatch(**kwargs):
        assert db.rolled_back is True
        assert db.closed is True

    with (
        patch("app.api.ws.chat_namespace.SessionLocal", return_value=db),
        patch(
            "app.api.ws.chat_namespace.can_access_task", AsyncMock(return_value=True)
        ),
        patch(
            "app.api.ws.chat_namespace.fetch_retry_context",
            return_value=(failed_ai_subtask, task, team, user_subtask),
        ),
        patch("app.api.ws.chat_namespace.reset_subtask_for_retry"),
        patch("app.api.ws.chat_namespace.extract_display_prompt", return_value="Hello"),
        patch("app.api.ws.chat_namespace.get_device_id", return_value=None),
        patch(
            "app.api.ws.chat_namespace.trigger_ai_response_unified",
            AsyncMock(side_effect=assert_session_closed_before_dispatch),
        ) as mock_trigger,
    ):
        result = await namespace.on_chat_retry(
            "sid-123",
            {
                "task_id": 100,
                "subtask_id": 42,
                "force_override_bot_model": None,
                "force_override_bot_model_type": None,
                "use_model_override": False,
            },
        )

    assert result == {"success": True}
    mock_trigger.assert_awaited_once()


@pytest.mark.asyncio
async def test_chat_retry_new_model_without_type_clears_stale_override_model_type():
    """Retrying with a new model should drop a stale override type when none is provided."""

    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace._check_token_expiry = AsyncMock(return_value=False)

    task = SimpleNamespace(
        id=100,
        json={
            "metadata": {
                "labels": {
                    "modelId": "old-model",
                    "forceOverrideBotModel": "true",
                    "forceOverrideBotModelType": "public",
                }
            }
        },
    )
    failed_ai_subtask = SimpleNamespace(
        id=42,
        team_id=10,
        message_id=7,
        parent_id=41,
        status=SimpleNamespace(value="FAILED"),
    )
    team = SimpleNamespace(id=10)
    user_subtask = SimpleNamespace(id=41, prompt="Hello", contexts=[])
    user = SimpleNamespace(id=1)

    db = Mock()
    db.query.return_value.filter.return_value.first.return_value = user

    with (
        patch("app.api.ws.chat_namespace.SessionLocal", return_value=db),
        patch(
            "app.api.ws.chat_namespace.can_access_task", AsyncMock(return_value=True)
        ),
        patch(
            "app.api.ws.chat_namespace.fetch_retry_context",
            return_value=(failed_ai_subtask, task, team, user_subtask),
        ),
        patch("app.api.ws.chat_namespace.reset_subtask_for_retry"),
        patch("app.api.ws.chat_namespace.extract_display_prompt", return_value="Hello"),
        patch("app.api.ws.chat_namespace.get_device_id", return_value=None),
        patch(
            "app.api.ws.chat_namespace.trigger_ai_response_unified",
            AsyncMock(),
        ) as mock_trigger,
        patch("sqlalchemy.orm.attributes.flag_modified") as mock_flag_modified,
    ):
        result = await namespace.on_chat_retry(
            "sid-123",
            {
                "task_id": 100,
                "subtask_id": 42,
                "force_override_bot_model": "new-model",
                "force_override_bot_model_type": None,
                "use_model_override": True,
            },
        )

    assert result == {"success": True}
    assert task.json["metadata"]["labels"] == {
        "modelId": "new-model",
        "forceOverrideBotModel": "true",
    }
    mock_flag_modified.assert_called_once_with(task, "json")
    assert db.commit.called
    assert mock_trigger.await_count == 1
    assert (
        mock_trigger.await_args.kwargs["payload"].force_override_bot_model
        == "new-model"
    )


@pytest.mark.asyncio
async def test_chat_retry_rejects_running_subtask_without_dispatching():
    """Retry should not re-dispatch a subtask that is still marked RUNNING."""

    namespace = ChatNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 1})
    namespace._check_token_expiry = AsyncMock(return_value=False)

    task = SimpleNamespace(id=100, json={"metadata": {"labels": {}}})
    running_ai_subtask = SimpleNamespace(
        id=42,
        team_id=10,
        message_id=7,
        parent_id=41,
        status=SimpleNamespace(value="RUNNING"),
    )
    team = SimpleNamespace(id=10)
    user_subtask = SimpleNamespace(id=41, prompt="Hello", contexts=[])

    db = Mock()

    with (
        patch("app.api.ws.chat_namespace.SessionLocal", return_value=db),
        patch(
            "app.api.ws.chat_namespace.can_access_task", AsyncMock(return_value=True)
        ),
        patch(
            "app.api.ws.chat_namespace.fetch_retry_context",
            return_value=(running_ai_subtask, task, team, user_subtask),
        ),
        patch("app.api.ws.chat_namespace.reset_subtask_for_retry") as mock_reset,
        patch(
            "app.api.ws.chat_namespace.trigger_ai_response_unified",
            AsyncMock(),
        ) as mock_trigger,
    ):
        result = await namespace.on_chat_retry(
            "sid-123",
            {
                "task_id": 100,
                "subtask_id": 42,
                "force_override_bot_model": None,
                "force_override_bot_model_type": None,
                "use_model_override": False,
            },
        )

    assert result == {"error": "Cannot retry subtask in RUNNING state"}
    mock_reset.assert_not_called()
    mock_trigger.assert_not_awaited()
