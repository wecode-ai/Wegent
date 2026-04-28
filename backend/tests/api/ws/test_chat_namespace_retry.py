# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.api.ws.chat_namespace import ChatNamespace


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
            "app.services.chat.trigger.trigger_ai_response_unified", AsyncMock()
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
            "app.services.chat.trigger.trigger_ai_response_unified", AsyncMock()
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
