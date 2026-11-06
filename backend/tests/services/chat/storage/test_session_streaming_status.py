# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Streaming metadata writers preserve ownership across Redis failures."""

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.core.cache import RedisCache
from app.services.chat.storage.session import STREAMING_TTL, SessionManager
from tests.services.chat.storage.test_session_blocks import FakeRedisClient

STATUS_KEY = "chat:task_streaming:101"
START = datetime(2026, 7, 29, tzinfo=timezone.utc)


class _StatusRedis(FakeRedisClient):
    """External Redis double with byte responses and the raw CAS protocol."""

    def __init__(self) -> None:
        super().__init__()
        self.get = AsyncMock(side_effect=self._get)
        self.set = AsyncMock(side_effect=self._set)
        self.eval = AsyncMock(side_effect=self._eval)

    @staticmethod
    def _bytes(value: bytes | str) -> bytes:
        return value.encode() if isinstance(value, str) else value

    async def _get(self, key: str) -> bytes | None:
        return self.values.get(key)

    async def _set(self, key: str, value: bytes | str, ex: int | None = None) -> bool:
        self.values[key] = self._bytes(value)
        if ex is not None:
            self.expirations[key] = ex
        return True

    async def _eval(
        self,
        script: str,
        numkeys: int,
        key: str,
        expected: bytes | str,
        payload: bytes | str,
        ttl: int,
    ) -> int:
        assert numkeys == 1
        assert "cjson" not in script
        if self.values.get(key, b"") != self._bytes(expected):
            return 0
        await self._set(key, payload, ex=ttl)
        return 1


def _cache_for_redis(client: FakeRedisClient) -> RedisCache:
    """Keep real cache JSON encoding while replacing only Redis transport."""
    cache = RedisCache("redis://unit-test.invalid/0")

    @asynccontextmanager
    async def context():
        yield client

    cache._client_context = context
    cache._get_client = AsyncMock(return_value=client)
    return cache


@pytest.fixture
def status_store():
    client = _StatusRedis()
    manager = SessionManager()
    manager._cache = _cache_for_redis(client)
    return manager, client


def _assert_utc_timestamp(value: object) -> datetime:
    assert isinstance(value, str)
    parsed = datetime.fromisoformat(value)
    assert parsed.utcoffset() == timezone.utc.utcoffset(parsed)
    return parsed


@pytest.mark.asyncio
async def test_task_streaming_status_uses_timezone_aware_utc_timestamps(status_store):
    manager, client = status_store

    before = datetime.now(timezone.utc)
    assert await manager.set_task_streaming_status(101, 202, 303, "tester")
    after = datetime.now(timezone.utc)

    assert isinstance(client.values[STATUS_KEY], bytes)
    status = json.loads(client.values[STATUS_KEY])
    started_at = _assert_utc_timestamp(status["started_at"])
    last_activity_at = _assert_utc_timestamp(status["last_activity_at"])
    assert before <= started_at <= after
    assert last_activity_at == started_at
    assert client.expirations[STATUS_KEY] == STREAMING_TTL


@pytest.mark.asyncio
async def test_touch_preserves_owner_and_start_with_utc_activity(status_store):
    manager, client = status_store
    with patch("app.services.chat.storage.session.datetime") as clock:
        clock.now.return_value = START
        assert await manager.set_task_streaming_status(101, 202, 303, "tester")
    original = json.loads(client.values[STATUS_KEY])

    before = datetime.now(timezone.utc)
    assert await manager.touch_task_streaming_activity(101, 202, started_at=START)
    after = datetime.now(timezone.utc)

    status = json.loads(client.values[STATUS_KEY])
    last_activity_at = _assert_utc_timestamp(status.pop("last_activity_at"))
    original.pop("last_activity_at")
    assert status == original
    assert before <= last_activity_at <= after
    assert client.expirations[STATUS_KEY] == STREAMING_TTL
    client.get.assert_awaited_once_with(STATUS_KEY)
    client.eval.assert_awaited_once()


@pytest.mark.asyncio
async def test_legacy_naive_streaming_timestamps_are_excluded_from_warning_data(
    status_store,
):
    manager, client = status_store
    assert await manager._cache.set(
        STATUS_KEY,
        {
            "subtask_id": 202,
            "started_at": "2026-07-29T00:00:00",
            "last_activity_at": "2026-07-29T00:01:00",
        },
    )

    status = await manager.get_task_streaming_status(101)

    assert isinstance(status, dict)
    assert status["started_at"] is None
    assert status["last_activity_at"] is None

    assert await manager.touch_task_streaming_activity(101, 202, started_at=START)
    stored_status = json.loads(client.values[STATUS_KEY])
    assert stored_status["started_at"] == "2026-07-29T00:00:00"
    _assert_utc_timestamp(stored_status["last_activity_at"])


@pytest.mark.asyncio
async def test_failed_start_write_is_recovered_by_business_activity(status_store):
    manager, client = status_store
    activity = START + timedelta(seconds=1)
    with patch("app.services.chat.storage.session.datetime") as clock:
        clock.now.side_effect = [START, activity]
        client.set.side_effect = ConnectionError("START write failed")
        assert not await manager.set_task_streaming_status(101, 202, 303, "tester")
        assert STATUS_KEY not in client.values

        client.set.side_effect = client._set
        assert await manager.touch_task_streaming_activity(101, 202, started_at=START)

    assert json.loads(client.values[STATUS_KEY]) == {
        "subtask_id": 202,
        "user_id": 0,
        "username": "",
        "started_at": START.isoformat(),
        "last_activity_at": activity.isoformat(),
    }
    assert client.expirations[STATUS_KEY] == STREAMING_TTL
    assert client.eval.await_args.args[3] == ""


@pytest.mark.asyncio
@pytest.mark.parametrize("owner", [203, "202", True])
async def test_touch_does_not_modify_other_or_invalid_owner(status_store, owner):
    manager, client = status_store
    assert await manager._cache.set(
        STATUS_KEY,
        {"subtask_id": owner, "started_at": START.isoformat()},
    )
    snapshot = client.values[STATUS_KEY]

    assert not await manager.touch_task_streaming_activity(101, 202, started_at=START)

    assert client.values[STATUS_KEY] == snapshot
    client.eval.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("existing", [False, True])
async def test_touch_preserves_subtask_ids_above_double_precision(
    status_store, existing
):
    manager, client = status_store
    subtask_id = 2**53 + 1
    if existing:
        assert await manager.set_task_streaming_status(101, subtask_id, 303, "tester")

    assert await manager.touch_task_streaming_activity(
        101, subtask_id, started_at=START
    )

    status = json.loads(client.values[STATUS_KEY])
    assert type(status["subtask_id"]) is int
    assert status["subtask_id"] == subtask_id


@pytest.mark.asyncio
@pytest.mark.parametrize("existing", [False, True])
async def test_concurrent_new_start_wins_over_activity_snapshot(status_store, existing):
    manager, client = status_store
    if existing:
        assert await manager.set_task_streaming_status(101, 202, 303, "old owner")
    snapshot_taken = asyncio.Event()
    release_snapshot = asyncio.Event()

    async def paused_get(key):
        snapshot = await client._get(key)
        snapshot_taken.set()
        await release_snapshot.wait()
        return snapshot

    client.get.side_effect = paused_get
    pending = asyncio.create_task(
        manager.touch_task_streaming_activity(101, 202, started_at=START)
    )
    try:
        await asyncio.wait_for(snapshot_taken.wait(), timeout=1)
        assert await manager.set_task_streaming_status(101, 204, 304, "new owner")
        new_start = client.values[STATUS_KEY]
        release_snapshot.set()

        assert await asyncio.wait_for(pending, timeout=1) is False

        assert client.values[STATUS_KEY] == new_start
        assert json.loads(new_start)["subtask_id"] == 204
    finally:
        release_snapshot.set()
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["get", "eval"])
async def test_touch_read_or_write_failure_returns_false_without_mutation(
    status_store, operation
):
    manager, client = status_store
    assert await manager.set_task_streaming_status(101, 202, 303, "tester")
    snapshot = client.values[STATUS_KEY]
    getattr(client, operation).side_effect = ConnectionError("Redis unavailable")

    assert not await manager.touch_task_streaming_activity(101, 202, started_at=START)

    assert client.values[STATUS_KEY] == snapshot


@pytest.mark.asyncio
async def test_real_emitter_activity_recovers_failed_start_and_guards_sweep(
    status_store, monkeypatch
):
    """Unit fault chain with real emitter, writer, probe and classification."""
    from app.services.chat.storage import execution_evidence
    from app.services.chat.storage import session as session_module
    from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
    from app.services.execution.stalled_tasks import (
        StalledCandidate,
        StalledSubtaskSweeper,
    )
    from shared.models import EventType, ExecutionEvent

    manager, client = status_store
    monkeypatch.setattr(session_module.session_manager, "_cache", manager._cache)
    monkeypatch.setattr(execution_evidence, "cache_manager", manager._cache)
    monkeypatch.setattr(
        "app.services.execution.stalled_tasks.executor_dispatch_pending",
        AsyncMock(return_value=False),
    )
    activity = START + timedelta(seconds=1)
    wrapped = AsyncMock()
    with (
        patch("app.services.execution.emitters.status_updating.datetime") as observer,
        patch("app.services.chat.storage.session.datetime") as storage_clock,
    ):
        observer.now.return_value = START
        storage_clock.now.side_effect = [START, activity]
        emitter = StatusUpdatingEmitter(wrapped, task_id=101, subtask_id=202)
        try:
            client.set.side_effect = ConnectionError("START write failed")
            await emitter.emit(
                ExecutionEvent(type=EventType.START.value, task_id=101, subtask_id=202)
            )
            assert STATUS_KEY not in client.values

            client.set.side_effect = client._set
            await emitter.emit(
                ExecutionEvent(
                    type=EventType.TOOL_START.value,
                    task_id=101,
                    subtask_id=202,
                    tool_use_id="tool-1",
                    tool_name="exec",
                    tool_input={"command": "pwd"},
                )
            )
        finally:
            await emitter.close()

    status = json.loads(client.values[STATUS_KEY])
    assert status["last_activity_at"] == activity.isoformat()
    block = json.loads(client.lists["chat:streaming:blocks:202"][0])
    assert (block["type"], block["tool_use_id"]) == ("tool", "tool-1")
    assert (
        await execution_evidence.has_execution_evidence(101, 202, since=START) is True
    )
    updated_at = START.astimezone().replace(tzinfo=None)
    candidate = StalledCandidate(101, 202, 303, "", "", updated_at)
    sweeper = StalledSubtaskSweeper(
        silent_timeout_seconds=900, heartbeat_timeout_seconds=1800
    )

    assert (
        await sweeper.classify(candidate, now=updated_at + timedelta(hours=2)) is None
    )
    assert [event.args[0].type for event in wrapped.emit.await_args_list] == [
        EventType.START.value,
        EventType.TOOL_START.value,
    ]
