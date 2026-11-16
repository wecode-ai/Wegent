# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Execution activity probes read only the current task streaming metadata."""

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.db import timezone as database_time
from app.models.subtask import Subtask, SubtaskStatus
from app.services.chat.storage import execution_evidence as evidence
from app.services.chat.storage.session import STREAMING_TTL, SessionManager
from app.stores.tasks.sqlalchemy_subtask_store import SqlAlchemySubtaskStore
from tests.services.chat.storage.test_session_streaming_status import (
    _cache_for_redis,
    _StatusRedis,
)

START = datetime(2026, 11, 5, 9, 30, 0, tzinfo=timezone.utc)
TASK_ID = 101
SUBTASK_ID = 202
STATUS_KEY = f"chat:task_streaming:{TASK_ID}"
SINCE = START - timedelta(seconds=12)


def _metadata(*, started_at=START, last_activity_at=START, subtask_id=SUBTASK_ID):
    return json.dumps(
        {
            "subtask_id": subtask_id,
            "started_at": started_at.isoformat(),
            "last_activity_at": last_activity_at.isoformat(),
        }
    )


class _MetadataRedis:
    """Reject every Redis operation except GET of the task streaming key."""

    def __init__(self):
        self.values = {}
        self.forbidden_operations = []
        self.get = AsyncMock(side_effect=self._get)

    async def _get(self, key):
        if key != STATUS_KEY:
            self.forbidden_operations.append(("get", key))
            raise AssertionError("The probe must not read another Redis key")
        return self.values.get(key)

    def __getattr__(self, operation):
        def forbidden(*args, **kwargs):
            self.forbidden_operations.append(operation)
            raise AssertionError("The probe must only GET metadata")

        return forbidden


def _writer_cache(client):
    """Share raw storage while keeping writer calls out of probe accounting."""
    writer = _StatusRedis()
    writer.values = client.values
    return _cache_for_redis(writer), writer


@pytest.fixture
def redis_probe(monkeypatch):
    client = _MetadataRedis()

    @asynccontextmanager
    async def context():
        yield client

    monkeypatch.setattr(evidence.cache_manager, "_client_context", context)
    yield client
    assert client.forbidden_operations == []
    assert all(call.args == (STATUS_KEY,) for call in client.get.await_args_list)


async def _probe(client, *, since=SINCE):
    before = dict(client.values)
    result = await evidence.has_execution_evidence(TASK_ID, SUBTASK_ID, since=since)
    assert client.values == before
    return result


@pytest.mark.asyncio
@pytest.mark.parametrize("as_bytes", [False, True])
@pytest.mark.parametrize(
    ("activity", "since"),
    [
        (START + timedelta(seconds=10), SINCE),
        (START + timedelta(seconds=10), START + timedelta(seconds=10)),
        (START + timedelta(microseconds=1), START + timedelta(microseconds=1)),
    ],
)
async def test_current_activity_is_evidence_with_one_get(
    redis_probe, activity, since, as_bytes
):
    raw = _metadata(last_activity_at=activity)
    redis_probe.values[STATUS_KEY] = raw.encode() if as_bytes else raw

    assert await _probe(redis_probe, since=since) is True

    redis_probe.get.assert_awaited_once_with(STATUS_KEY)


@pytest.mark.asyncio
async def test_timezone_aware_offsets_are_compared_as_instants(redis_probe):
    offset = timezone(timedelta(hours=8))
    redis_probe.values[STATUS_KEY] = _metadata(
        started_at=START.astimezone(offset),
        last_activity_at=(START + timedelta(seconds=1)).astimezone(offset),
    )

    assert await _probe(redis_probe) is True

    redis_probe.get.assert_awaited_once_with(STATUS_KEY)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("raw", "since"),
    [
        (None, SINCE),
        (_metadata(), SINCE),
        (
            _metadata(last_activity_at=START + timedelta(seconds=5)),
            START + timedelta(seconds=6),
        ),
        (
            _metadata(last_activity_at=START + timedelta(microseconds=1)),
            START + timedelta(microseconds=2),
        ),
        (
            _metadata(
                started_at=START - timedelta(minutes=5),
                last_activity_at=START - timedelta(minutes=4),
            ),
            SINCE,
        ),
    ],
)
async def test_absent_start_only_and_previous_activity_require_two_stable_gets(
    redis_probe, raw, since
):
    if raw is not None:
        redis_probe.values[STATUS_KEY] = raw

    assert await _probe(redis_probe, since=since) is False

    assert redis_probe.get.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("first", "second"),
    [
        (None, _metadata()),
        (_metadata(), _metadata(last_activity_at=START + timedelta(seconds=1))),
        (_metadata(), _metadata(subtask_id=999)),
        (
            _metadata(),
            _metadata(
                started_at=START + timedelta(minutes=1),
                last_activity_at=START + timedelta(minutes=1),
            ),
        ),
        (_metadata(), None),
    ],
)
async def test_negative_snapshot_change_is_unknown(redis_probe, first, second):
    redis_probe.get.side_effect = [first, second]

    assert await _probe(redis_probe) is None

    assert redis_probe.get.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw",
    [
        "invalid json",
        "null",
        "[]",
        "{}",
        json.dumps(
            {"started_at": START.isoformat(), "last_activity_at": START.isoformat()}
        ),
        json.dumps({"subtask_id": SUBTASK_ID, "started_at": START.isoformat()}),
        json.dumps({"subtask_id": SUBTASK_ID, "last_activity_at": START.isoformat()}),
        _metadata(subtask_id=999),
        _metadata(subtask_id=str(SUBTASK_ID)),
        _metadata(subtask_id=True),
        _metadata(started_at=START.replace(tzinfo=None)),
        _metadata(last_activity_at=START.replace(tzinfo=None)),
        _metadata(last_activity_at=START - timedelta(seconds=1)),
        json.dumps(
            {
                "subtask_id": SUBTASK_ID,
                "started_at": "invalid",
                "last_activity_at": START.isoformat(),
            }
        ),
        json.dumps(
            {
                "subtask_id": SUBTASK_ID,
                "started_at": START.isoformat(),
                "last_activity_at": None,
            }
        ),
    ],
)
async def test_invalid_legacy_or_differently_owned_metadata_is_unknown(
    redis_probe, raw
):
    redis_probe.values[STATUS_KEY] = raw

    assert await _probe(redis_probe) is None

    redis_probe.get.assert_awaited_once_with(STATUS_KEY)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("process_timezone", "db_timezone", "expected"),
    [
        ("GMT-8", timezone.utc, True),
        ("UTC0", timezone(timedelta(hours=8)), False),
    ],
)
async def test_store_running_time_uses_process_timezone_when_db_timezone_differs(
    test_db, redis_probe, monkeypatch, process_timezone, db_timezone, expected
):
    previous_timezone = os.environ.get("TZ")
    try:
        monkeypatch.setenv("TZ", process_timezone)
        time.tzset()
        monkeypatch.setattr(database_time, "DATABASE_DATETIME_TIMEZONE", db_timezone)
        assert datetime.now().astimezone().utcoffset() != db_timezone.utcoffset(None)
        subtask = Subtask(
            id=SUBTASK_ID,
            task_id=TASK_ID,
            user_id=7,
            team_id=1,
            title="timezone test",
            bot_ids=[1],
            status=SubtaskStatus.PENDING,
        )
        test_db.add(subtask)
        test_db.flush()
        before = datetime.now(timezone.utc)
        SqlAlchemySubtaskStore().update_fields(
            test_db, subtask=subtask, status=SubtaskStatus.RUNNING
        )
        test_db.flush()
        test_db.refresh(subtask)
        after = datetime.now(timezone.utc)
        assert subtask.status == SubtaskStatus.RUNNING
        assert subtask.updated_at.tzinfo is None
        activity = (
            after + timedelta(microseconds=1)
            if expected
            else before - timedelta(microseconds=1)
        )
        redis_probe.values[STATUS_KEY] = _metadata(
            started_at=before - timedelta(seconds=1), last_activity_at=activity
        )

        assert await _probe(redis_probe, since=subtask.updated_at) is expected

        assert redis_probe.get.await_count == (1 if expected else 2)
    finally:
        if previous_timezone is None:
            monkeypatch.delenv("TZ", raising=False)
        else:
            monkeypatch.setenv("TZ", previous_timezone)
        time.tzset()


@pytest.mark.asyncio
async def test_two_hour_runtime_with_recent_activity_is_evidence(redis_probe):
    redis_probe.values[STATUS_KEY] = _metadata(
        last_activity_at=START + timedelta(hours=2)
    )

    assert await _probe(redis_probe, since=START + timedelta(hours=1)) is True

    redis_probe.get.assert_awaited_once_with(STATUS_KEY)


@pytest.mark.asyncio
@pytest.mark.parametrize("touch", [False, True])
async def test_real_session_start_and_touch_writer_formats(redis_probe, touch):
    manager = SessionManager()
    cache, writer = _writer_cache(redis_probe)
    manager._cache = cache
    with patch("app.services.chat.storage.session.datetime") as clock:
        clock.now.side_effect = [START, START + timedelta(seconds=1)]
        assert await manager.set_task_streaming_status(
            TASK_ID, SUBTASK_ID, 303, "tester"
        )
        if touch:
            assert await manager.touch_task_streaming_activity(
                TASK_ID, SUBTASK_ID, started_at=START
            )
    assert writer.expirations[STATUS_KEY] == STREAMING_TTL

    assert await _probe(redis_probe) is touch

    assert redis_probe.get.await_count == (1 if touch else 2)


@pytest.mark.asyncio
async def test_same_subtask_retry_start_resets_previous_activity(redis_probe):
    manager = SessionManager()
    manager._cache, _ = _writer_cache(redis_probe)
    retry_start = START + timedelta(minutes=1)
    with patch("app.services.chat.storage.session.datetime") as clock:
        clock.now.side_effect = [START, START + timedelta(seconds=1), retry_start]
        assert await manager.set_task_streaming_status(
            TASK_ID, SUBTASK_ID, 303, "tester"
        )
        assert await manager.touch_task_streaming_activity(
            TASK_ID, SUBTASK_ID, started_at=START
        )
        assert await manager.set_task_streaming_status(
            TASK_ID, SUBTASK_ID, 303, "tester"
        )

    assert await _probe(redis_probe, since=retry_start) is False

    assert redis_probe.get.await_count == 2


@pytest.mark.asyncio
async def test_large_body_storage_is_not_read_or_modified(redis_probe):
    redis_probe.values[STATUS_KEY] = _metadata(
        last_activity_at=START + timedelta(seconds=1)
    )
    redis_probe.values[f"chat:streaming:{SUBTASK_ID}"] = "x" * 1_000_000
    redis_probe.values[f"chat:streaming:blocks:{SUBTASK_ID}"] = "unreadable block body"

    assert await _probe(redis_probe) is True

    redis_probe.get.assert_awaited_once_with(STATUS_KEY)


@pytest.mark.asyncio
@pytest.mark.parametrize("during_second_get", [False, True])
async def test_redis_failure_is_unknown(redis_probe, during_second_get):
    error = ConnectionError("Redis unavailable")
    redis_probe.get.side_effect = [_metadata(), error] if during_second_get else error

    assert await _probe(redis_probe) is None

    assert redis_probe.get.await_count == (2 if during_second_get else 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_read", [1, 2])
async def test_probe_timeout_cancels_pending_get(
    redis_probe, monkeypatch, blocked_read
):
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    reads = 0

    async def blocked_get(key):
        nonlocal reads
        reads += 1
        if reads < blocked_read:
            return _metadata()
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    redis_probe.get.side_effect = blocked_get
    monkeypatch.setattr(evidence, "EVIDENCE_TIMEOUT_SECONDS", 0.01)

    assert await asyncio.wait_for(_probe(redis_probe), timeout=1) is None

    assert entered.is_set() and cancelled.is_set()
    assert redis_probe.get.await_count == blocked_read
