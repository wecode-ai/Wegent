# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for task model override labels and channel override sources."""

import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

# Importing chat_namespace first breaks an existing import cycle between the
# chat trigger package and the WebSocket namespace when this file is collected
# before the WebSocket tests in a fresh process.
import app.api.ws.chat_namespace as _chat_namespace  # noqa: F401
from app.services.chat.model_override import (
    MODEL_OVERRIDE_LABEL_KEYS,
    MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT,
    MODEL_OVERRIDE_SOURCE_DEVICE_DEFAULT,
    MODEL_OVERRIDE_SOURCE_LABEL,
    MODEL_OVERRIDE_SOURCE_USER_SELECTION,
    apply_model_override_labels,
    clear_model_override_labels,
)
from app.services.chat.storage.task_manager import TaskCreationParams
from app.services.chat.trigger.lifecycle import (
    sync_existing_task_model_override_labels,
)


def test_apply_model_override_labels_writes_all_entries() -> None:
    labels: dict = {}
    apply_model_override_labels(
        labels,
        model_id="wecode-moonshot-kimi-k2.6(公网)",
        force_override=True,
        model_type="public",
        source=MODEL_OVERRIDE_SOURCE_USER_SELECTION,
        model_options={"reasoning": "high"},
    )
    assert labels["modelId"] == "wecode-moonshot-kimi-k2.6(公网)"
    assert labels["forceOverrideBotModel"] == "true"
    assert labels["forceOverrideBotModelType"] == "public"
    assert labels[MODEL_OVERRIDE_SOURCE_LABEL] == MODEL_OVERRIDE_SOURCE_USER_SELECTION
    assert json.loads(labels["modelOptions"]) == {"reasoning": "high"}


def test_clear_model_override_labels_removes_all_entries() -> None:
    labels = {
        "modelId": "old-model",
        "forceOverrideBotModel": "true",
        "forceOverrideBotModelType": "public",
        MODEL_OVERRIDE_SOURCE_LABEL: MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT,
        "modelOptions": "{}",
        "taskType": "chat",
    }
    assert clear_model_override_labels(labels) is True
    assert labels == {"taskType": "chat"}

    assert clear_model_override_labels(labels) is False


def test_clear_model_override_labels_covers_label_reader_keys() -> None:
    # Every key readers rely on must be removable so no stale override can
    # survive a "use Bot default" request.
    labels = {key: "value" for key in MODEL_OVERRIDE_LABEL_KEYS}
    clear_model_override_labels(labels)
    assert labels == {}


def test_sync_reconcile_clears_stale_override_when_no_current_model() -> None:
    task_json = {
        "metadata": {
            "labels": {
                "modelId": "openai-gpt-5.1(海外)",
                "forceOverrideBotModel": "true",
                MODEL_OVERRIDE_SOURCE_LABEL: MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT,
                "taskType": "chat",
            }
        }
    }
    params = TaskCreationParams(
        message="hello",
        task_type="chat",
        reconcile_model_override=True,
    )
    assert sync_existing_task_model_override_labels(task_json, params) is True
    assert task_json["metadata"]["labels"] == {"taskType": "chat"}


def test_sync_reconcile_replaces_override_with_current_model() -> None:
    task_json = {
        "metadata": {
            "labels": {
                "modelId": "openai-gpt-5.1(海外)",
                "forceOverrideBotModel": "true",
                "forceOverrideBotModelType": "public",
                MODEL_OVERRIDE_SOURCE_LABEL: MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT,
            }
        }
    }
    params = TaskCreationParams(
        message="hello",
        task_type="chat",
        model_id="wecode-moonshot-kimi-k2.6(公网)",
        model_override_source=MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT,
        reconcile_model_override=True,
    )
    assert sync_existing_task_model_override_labels(task_json, params) is True
    assert task_json["metadata"]["labels"] == {
        "modelId": "wecode-moonshot-kimi-k2.6(公网)",
        "forceOverrideBotModel": "true",
        MODEL_OVERRIDE_SOURCE_LABEL: MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT,
    }


def test_sync_without_reconcile_keeps_existing_behavior() -> None:
    task_json = {
        "metadata": {
            "labels": {
                "modelId": "old-model",
                "forceOverrideBotModel": "true",
                MODEL_OVERRIDE_SOURCE_LABEL: MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT,
            }
        }
    }
    params = TaskCreationParams(
        message="hello",
        task_type="chat",
        model_id="new-model",
    )
    assert sync_existing_task_model_override_labels(task_json, params) is True
    labels = task_json["metadata"]["labels"]
    assert labels["modelId"] == "new-model"
    assert labels["forceOverrideBotModel"] == "true"
    # Non-reconcile callers only add entries; stale source stays untouched.
    assert labels[MODEL_OVERRIDE_SOURCE_LABEL] == MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT


def test_sync_returns_false_without_changes() -> None:
    task_json = {"metadata": {"labels": {"taskType": "chat"}}}
    params = TaskCreationParams(message="hello", task_type="chat")
    assert sync_existing_task_model_override_labels(task_json, params) is False
    assert task_json["metadata"]["labels"] == {"taskType": "chat"}


@pytest.mark.asyncio
async def test_user_model_override_source_is_user_selection() -> None:
    handler = SimpleNamespace(default_model_name="openai-gpt-5.1(海外)")
    selection = SimpleNamespace(
        model_name="wecode-moonshot-kimi-k2.6(公网)",
        model_type="public",
    )
    from app.services.channels.handler import BaseChannelHandler

    with patch(
        "app.services.channels.handler.model_selection_manager.get_selection",
        AsyncMock(return_value=selection),
    ):
        name, model_type, source = await BaseChannelHandler._get_user_model_override(
            handler, user_id=1
        )
    assert name == "wecode-moonshot-kimi-k2.6(公网)"
    assert model_type == "public"
    assert source == MODEL_OVERRIDE_SOURCE_USER_SELECTION


@pytest.mark.asyncio
async def test_channel_default_model_override_source_is_channel_default() -> None:
    handler = SimpleNamespace(default_model_name="openai-gpt-5.1(海外)")
    from app.services.channels.handler import BaseChannelHandler

    with patch(
        "app.services.channels.handler.model_selection_manager.get_selection",
        AsyncMock(return_value=None),
    ):
        name, model_type, source = await BaseChannelHandler._get_user_model_override(
            handler, user_id=1
        )
    assert name == "openai-gpt-5.1(海外)"
    assert model_type is None
    assert source == MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT


@pytest.mark.asyncio
async def test_device_default_model_override_source_is_device_default() -> None:
    from app.services.channels.handler import BaseChannelHandler

    handler = SimpleNamespace(
        default_model_name="",
        _channel_type=SimpleNamespace(value="weibo"),
        logger=logging.getLogger("test-handler"),
    )
    user = SimpleNamespace(id=1)
    db = SimpleNamespace()

    available = [
        {
            "name": "wecode-claude-sonnet-4-5(海外)",
            "type": "public",
            "provider": "anthropic",
        }
    ]
    with (
        patch(
            "app.services.channels.handler.model_selection_manager.get_selection",
            AsyncMock(return_value=None),
        ),
        patch(
            "app.services.channels.handler.is_claude_provider",
            return_value=True,
        ),
        patch(
            "app.services.model_aggregation_service.model_aggregation_service"
            ".list_available_models",
            return_value=available,
        ),
        patch(
            "app.core.config.settings.IM_CHANNEL_DEVICE_DEFAULT_MODEL",
            "wecode-claude-sonnet-4-5(海外)",
            create=True,
        ),
    ):
        name, model_type, source = (
            await BaseChannelHandler._get_device_mode_model_override(handler, db, user)
        )
    assert name == "wecode-claude-sonnet-4-5(海外)"
    assert model_type == "public"
    assert source == MODEL_OVERRIDE_SOURCE_DEVICE_DEFAULT
