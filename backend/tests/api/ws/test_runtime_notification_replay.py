# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime IM delivery must survive reconnects and dispatcher recreation."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.ws import device_namespace
from app.api.ws.device_namespace import DeviceNamespace
from app.core.cache import cache_manager
from app.services.im.notification_dispatcher import IMNotificationDispatcher
from app.services.im.session_service import im_session_service


class DeliveryRedis:
    def __init__(self):
        self.values = {}
        self.locks = set()

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value):
        self.values[key] = value
        return True

    def lock(self, key, **kwargs):
        client = self

        class Lock:
            async def acquire(self):
                if key in client.locks:
                    return False
                client.locks.add(key)
                return True

            async def owned(self):
                return key in client.locks

            async def release(self):
                client.locks.remove(key)

        return Lock()

    async def aclose(self):
        pass


@pytest.fixture
def delivery(monkeypatch):
    redis = DeliveryRedis()
    monkeypatch.setattr(cache_manager, "_get_client", AsyncMock(return_value=redis))
    monkeypatch.setattr(
        device_namespace, "run_sync_in_executor", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(device_namespace, "get_sio", lambda: AsyncMock())
    monkeypatch.setattr(
        "app.services.wework_api.events.publish_runtime_event", AsyncMock()
    )
    monkeypatch.setattr(
        im_session_service, "save_runtime_task_reply_target", AsyncMock()
    )
    sessions = [
        SimpleNamespace(
            session_key="recipient-1", user_id=7, channel_id=1, channel_type="dingtalk"
        )
    ]
    send = AsyncMock(
        return_value={"success": True, "result": {"processQueryKey": "outgoing-1"}}
    )

    def reconnect():
        dispatcher = IMNotificationDispatcher()
        monkeypatch.setattr(
            dispatcher,
            "_runtime_notification_sessions",
            AsyncMock(return_value=sessions),
        )
        monkeypatch.setattr(dispatcher, "send_text", send)
        monkeypatch.setattr(device_namespace, "im_notification_dispatcher", dispatcher)
        namespace = DeviceNamespace()
        monkeypatch.setattr(
            namespace,
            "get_session",
            AsyncMock(return_value={"user_id": 7, "device_id": "local-device"}),
        )
        return namespace

    async def emit(namespace, *, turn_id="turn-1", **changes):
        payload = {
            "event_type": "response.completed",
            "taskId": "task-1",
            "subtaskId": turn_id,
            "taskTitle": "Task title",
            "data": {"value": "Task finished", "turnId": turn_id},
            **changes,
        }
        return await namespace.on_runtime_event(
            "device-sid", {"event": payload["event_type"], "payload": payload}
        )

    return SimpleNamespace(
        reconnect=reconnect, emit=emit, send=send, sessions=sessions, redis=redis
    )


@pytest.mark.asyncio
async def test_replayed_completion_is_not_sent_after_reconnect(delivery):
    assert await delivery.emit(delivery.reconnect(), eventSeq=100) == {"success": True}
    assert await delivery.emit(
        delivery.reconnect(), eventSeq=1, workspacePath="/moved/workspace"
    ) == {"success": True}

    delivery.send.assert_awaited_once()


@pytest.mark.asyncio
async def test_new_turn_with_identical_content_still_sends(delivery):
    namespace = delivery.reconnect()
    await delivery.emit(namespace, turn_id="turn-1")
    await delivery.emit(namespace, turn_id="turn-2")

    assert delivery.send.await_count == 2


@pytest.mark.asyncio
async def test_failed_delivery_can_be_replayed(delivery):
    delivery.send.side_effect = [{"success": False}, {"success": True}]
    await delivery.emit(delivery.reconnect())
    await delivery.emit(delivery.reconnect())
    await delivery.emit(delivery.reconnect())

    assert delivery.send.await_count == 2


@pytest.mark.asyncio
async def test_partial_failure_retries_only_failed_recipient(delivery):
    delivery.sessions.append(
        SimpleNamespace(
            session_key="recipient-2", user_id=7, channel_id=2, channel_type="dingtalk"
        )
    )
    delivery.send.side_effect = [
        {"success": True},
        {"success": False},
        {"success": True},
    ]
    await delivery.emit(delivery.reconnect())
    await delivery.emit(delivery.reconnect())

    assert [call.args[1].session_key for call in delivery.send.await_args_list] == [
        "recipient-1",
        "recipient-2",
        "recipient-2",
    ]


@pytest.mark.asyncio
async def test_concurrent_replay_sends_once(delivery):
    started, release = asyncio.Event(), asyncio.Event()

    async def held_send(*args):
        started.set()
        await release.wait()
        return {"success": True}

    delivery.send.side_effect = held_send
    namespace = delivery.reconnect()
    first = asyncio.create_task(delivery.emit(namespace))
    await started.wait()
    second = asyncio.create_task(delivery.emit(namespace))
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(first, second)

    delivery.send.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event_type", "data"),
    [
        ("response.failed", {"error": {"message": "Model request failed"}}),
        ("response.incomplete", {"error": {"message": "Turn cancelled"}}),
        ("error", {"message": "Transport failed"}),
        (
            "response.completed",
            {"value": "", "silent_exit_reason": "waiting_for_user_input"},
        ),
    ],
)
async def test_other_terminal_replays_are_deduplicated(delivery, event_type, data):
    await delivery.emit(delivery.reconnect(), event_type=event_type, data=data)
    await delivery.emit(delivery.reconnect(), event_type=event_type, data=data)

    delivery.send.assert_awaited_once()


@pytest.mark.asyncio
async def test_legacy_watcher_replay_uses_update_timestamp(delivery):
    namespace = delivery.reconnect()
    update = {
        "localTaskId": "task-1",
        "title": "Legacy task",
        "status": "done",
        "content": "Task finished",
        "updatedAt": "2026-10-12T08:00:00Z",
    }
    await namespace.on_runtime_task_updated("device-sid", update)
    result = await delivery.reconnect().on_runtime_task_updated("device-sid", update)
    assert result == {"success": True, "notified": 0}
    delivery.send.assert_awaited_once()

    await namespace.on_runtime_task_updated(
        "device-sid", {**update, "updatedAt": "2026-10-12T09:00:00Z"}
    )
    assert delivery.send.await_count == 2


@pytest.mark.asyncio
async def test_task_identity_does_not_suppress_another_task(delivery):
    namespace = delivery.reconnect()
    await delivery.emit(namespace, taskId="task-1")
    await delivery.emit(namespace, taskId="task-2")

    assert delivery.send.await_count == 2


@pytest.mark.asyncio
async def test_no_recipients_does_not_record_a_delivery(delivery):
    session = delivery.sessions.pop()
    namespace = delivery.reconnect()
    await delivery.emit(namespace)
    delivery.sessions.append(session)
    await delivery.emit(namespace)

    delivery.send.assert_awaited_once()


@pytest.mark.asyncio
async def test_send_exception_releases_claim_for_replay(delivery):
    delivery.send.side_effect = [
        RuntimeError("Transport unavailable"),
        {"success": True},
    ]
    await delivery.emit(delivery.reconnect())
    await delivery.emit(delivery.reconnect())
    await delivery.emit(delivery.reconnect())

    assert delivery.send.await_count == 2
    assert not delivery.redis.locks


@pytest.mark.asyncio
async def test_receipt_read_failure_preserves_relay_and_does_not_send(
    delivery, monkeypatch
):
    read = delivery.redis.get
    monkeypatch.setattr(
        delivery.redis, "get", AsyncMock(side_effect=RuntimeError("Redis unavailable"))
    )
    assert await delivery.emit(delivery.reconnect()) == {"success": True}
    delivery.send.assert_not_awaited()
    assert not delivery.redis.locks

    monkeypatch.setattr(delivery.redis, "get", read)
    await delivery.emit(delivery.reconnect())
    delivery.send.assert_awaited_once()
