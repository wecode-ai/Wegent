# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Ephemeral cross-worker transport and subscription lifecycle contracts."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.wework_api import events


@pytest.mark.asyncio
async def test_subscribe_waits_for_ack_and_closes_all_resources(monkeypatch):
    pubsub = MagicMock()
    pubsub.subscribe = AsyncMock()
    pubsub.get_message = AsyncMock(
        side_effect=[
            {"type": "subscribe"},
            {"type": "message", "data": b'{"event":"response.created"}'},
        ]
    )
    pubsub.aclose = AsyncMock()
    client = MagicMock()
    client.pubsub.return_value = pubsub
    client.aclose = AsyncMock()
    monkeypatch.setattr(
        events.cache_manager, "_get_client", AsyncMock(return_value=client)
    )
    subscription = await events.subscribe(1, "device", "task")
    pubsub.get_message.assert_awaited_once_with(timeout=5.0)
    assert (await subscription.receive())["event"] == "response.created"
    await subscription.close()
    pubsub.aclose.assert_awaited_once()
    client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_missing_subscription_ack_releases_connections(monkeypatch):
    client = MagicMock()
    pubsub = MagicMock()
    client.pubsub.return_value = pubsub
    client.aclose = AsyncMock()
    pubsub.subscribe = AsyncMock()
    pubsub.get_message = AsyncMock(return_value=None)
    pubsub.aclose = AsyncMock()
    monkeypatch.setattr(
        events.cache_manager, "_get_client", AsyncMock(return_value=client)
    )
    with pytest.raises(RuntimeError, match="not acknowledged"):
        await events.subscribe(1, "device", "task")
    pubsub.aclose.assert_awaited_once()
    client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_publishing_is_user_device_task_scoped_and_does_not_store_events(
    monkeypatch,
):
    client = MagicMock()
    client.publish = AsyncMock()
    client.aclose = AsyncMock()
    monkeypatch.setattr(
        events.cache_manager, "_get_client", AsyncMock(return_value=client)
    )
    envelope = {"event": "response.created", "payload": {"taskId": "task"}}
    await events.publish_runtime_event(1, "device", envelope)
    client.publish.assert_awaited_once_with(
        events.channel(1, "device", "task"), json.dumps(envelope)
    )
    assert events.channel(1, "device", "task") != events.channel(2, "device", "task")
    assert events.channel(1, "device", "task") != events.channel(
        1, "other-device", "task"
    )
    client.set.assert_not_called()
    client.xadd.assert_not_called()
    client.aclose.assert_awaited_once()
