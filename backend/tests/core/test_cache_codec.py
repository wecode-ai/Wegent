# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Loop-isolation tests for Redis cache payload codecs."""

import asyncio
import threading
import time
from unittest.mock import AsyncMock

import pytest

from app.core import cache as cache_module
from app.core.cache import RedisCache


async def _assert_started_without_blocking_loop(
    started: threading.Event,
    started_at: float,
) -> None:
    while not started.is_set() and time.monotonic() - started_at < 1.5:
        await asyncio.sleep(0)
    assert started.is_set()
    assert time.monotonic() - started_at < 0.2


@pytest.mark.asyncio
async def test_large_cache_value_encoding_does_not_block_loop(monkeypatch) -> None:
    cache = RedisCache("redis://localhost:6379/0")
    client = AsyncMock()
    client.set.return_value = True
    monkeypatch.setattr(cache, "_get_client", AsyncMock(return_value=client))

    started = threading.Event()
    release = threading.Event()

    def blocking_dumps(value):
        started.set()
        release.wait(timeout=1.0)
        return b'"encoded"'

    monkeypatch.setattr(cache_module.orjson, "dumps", blocking_dumps)
    started_at = time.monotonic()
    cache_task = asyncio.create_task(cache.set("large", "x" * (64 * 1024), expire=60))
    await _assert_started_without_blocking_loop(started, started_at)
    assert not cache_task.done()

    release.set()
    assert await asyncio.wait_for(cache_task, timeout=1.0) is True
    client.set.assert_awaited_once_with("large", b'"encoded"', ex=60)


@pytest.mark.asyncio
async def test_large_cache_value_decoding_does_not_block_loop(monkeypatch) -> None:
    cache = RedisCache("redis://localhost:6379/0")
    client = AsyncMock()
    client.get.return_value = b"x" * (64 * 1024)
    monkeypatch.setattr(cache, "_get_client", AsyncMock(return_value=client))

    started = threading.Event()
    release = threading.Event()

    def blocking_loads(value):
        started.set()
        release.wait(timeout=1.0)
        return {"decoded": len(value)}

    monkeypatch.setattr(cache_module.orjson, "loads", blocking_loads)
    started_at = time.monotonic()
    cache_task = asyncio.create_task(cache.get("large"))
    await _assert_started_without_blocking_loop(started, started_at)
    assert not cache_task.done()

    release.set()
    assert await asyncio.wait_for(cache_task, timeout=1.0) == {"decoded": 64 * 1024}
