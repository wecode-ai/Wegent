# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone

import pytest

from app.services.chat.storage.session import STREAMING_TTL, SessionManager


class _StatusCache:
    def __init__(self) -> None:
        self.values: dict[str, object] = {}
        self.expirations: dict[str, int] = {}

    async def get(self, key: str):
        return self.values.get(key)

    async def set(self, key: str, value: object, expire: int | None = None) -> bool:
        self.values[key] = value
        if expire is not None:
            self.expirations[key] = expire
        return True


def _assert_utc_timestamp(value: object) -> datetime:
    assert isinstance(value, str)
    parsed = datetime.fromisoformat(value)
    assert parsed.utcoffset() == timezone.utc.utcoffset(parsed)
    return parsed


@pytest.mark.asyncio
async def test_task_streaming_status_uses_timezone_aware_utc_timestamps():
    manager = SessionManager()
    cache = _StatusCache()
    manager._cache = cache

    before = datetime.now(timezone.utc)
    assert await manager.set_task_streaming_status(101, 202, 303, "tester")
    after = datetime.now(timezone.utc)

    status = cache.values["chat:task_streaming:101"]
    assert isinstance(status, dict)
    started_at = _assert_utc_timestamp(status["started_at"])
    last_activity_at = _assert_utc_timestamp(status["last_activity_at"])
    assert before <= started_at <= after
    assert last_activity_at == started_at
    assert cache.expirations["chat:task_streaming:101"] == STREAMING_TTL


@pytest.mark.asyncio
async def test_touch_task_streaming_activity_uses_timezone_aware_utc_timestamp():
    manager = SessionManager()
    cache = _StatusCache()
    cache.values["chat:task_streaming:101"] = {
        "subtask_id": 202,
        "started_at": "2026-07-29T00:00:00+00:00",
        "last_activity_at": "2026-07-29T00:00:00+00:00",
    }
    manager._cache = cache

    before = datetime.now(timezone.utc)
    assert await manager.touch_task_streaming_activity(101)
    after = datetime.now(timezone.utc)

    status = cache.values["chat:task_streaming:101"]
    assert isinstance(status, dict)
    last_activity_at = _assert_utc_timestamp(status["last_activity_at"])
    assert before <= last_activity_at <= after
    assert cache.expirations["chat:task_streaming:101"] == STREAMING_TTL


@pytest.mark.asyncio
async def test_legacy_naive_streaming_timestamps_are_excluded_from_warning_data():
    manager = SessionManager()
    cache = _StatusCache()
    cache.values["chat:task_streaming:101"] = {
        "subtask_id": 202,
        "started_at": "2026-07-29T00:00:00",
        "last_activity_at": "2026-07-29T00:01:00",
    }
    manager._cache = cache

    status = await manager.get_task_streaming_status(101)

    assert isinstance(status, dict)
    assert status["started_at"] is None
    assert status["last_activity_at"] is None

    assert await manager.touch_task_streaming_activity(101)
    stored_status = cache.values["chat:task_streaming:101"]
    assert isinstance(stored_status, dict)
    assert stored_status["started_at"] == "2026-07-29T00:00:00"
    _assert_utc_timestamp(stored_status["last_activity_at"])
