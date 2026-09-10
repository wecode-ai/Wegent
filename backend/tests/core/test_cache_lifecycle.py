# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from unittest.mock import AsyncMock, MagicMock

import orjson
import pytest
from redis.exceptions import TimeoutError as RedisTimeoutError

from app.core.cache import RedisCache


@pytest.mark.asyncio
async def test_get_client_reuses_application_owned_pool() -> None:
    cache = RedisCache("redis://localhost:6379/0")
    await cache.start()

    first = await cache._get_client()
    second = await cache._get_client()

    assert first is second
    assert first.connection_pool is cache._pool
    assert first.auto_close_connection_pool is False
    await cache.aclose()


@pytest.mark.asyncio
async def test_get_client_isolates_short_lived_event_loops() -> None:
    cache = RedisCache("redis://localhost:6379/0")
    await cache.start()
    owner_client = await cache._get_client()

    async def get_and_close_client() -> object:
        client = await cache._get_client()
        await client.aclose()
        return client

    transient_client = await asyncio.to_thread(
        lambda: asyncio.run(get_and_close_client())
    )

    assert transient_client is not owner_client
    await cache.aclose()


@pytest.mark.asyncio
async def test_cache_command_closes_short_lived_loop_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = RedisCache("redis://localhost:6379/0")
    await cache.start()
    transient_client = AsyncMock()
    transient_client.get.return_value = orjson.dumps({"status": "online"})
    from_url = MagicMock(return_value=transient_client)
    monkeypatch.setattr("app.core.cache.Redis.from_url", from_url)

    result = await asyncio.to_thread(
        lambda: asyncio.run(cache.get("device:online:7:device-1"))
    )

    assert result == {"status": "online"}
    from_url.assert_called_once()
    transient_client.aclose.assert_awaited_once_with()
    await cache.aclose()


@pytest.mark.asyncio
async def test_get_does_not_close_client_after_each_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = RedisCache("redis://localhost:6379/0")
    await cache.start()
    client = AsyncMock()
    client.get.return_value = orjson.dumps({"status": "online"})
    monkeypatch.setattr(cache, "_get_client", AsyncMock(return_value=client))

    first = await cache.get("device:online:7:device-1")
    second = await cache.get("device:online:7:device-1")

    assert first == {"status": "online"}
    assert second == first
    assert client.get.await_count == 2
    client.aclose.assert_not_awaited()
    await cache.aclose()


@pytest.mark.asyncio
async def test_strict_get_distinguishes_redis_failure_from_cache_miss(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = RedisCache("redis://localhost:6379/0")
    client = AsyncMock()
    monkeypatch.setattr(cache, "_get_client", AsyncMock(return_value=client))
    client.get.return_value = None

    assert await cache.get_or_raise("missing") is None

    client.get.side_effect = RedisTimeoutError("Redis unavailable")
    with pytest.raises(RedisTimeoutError, match="Redis unavailable"):
        await cache.get_or_raise("device:online:7:device-1")
    assert await cache.get("device:online:7:device-1") is None


def test_set_from_sync_uses_the_process_owned_sync_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = RedisCache("redis://localhost:6379/0")
    client = MagicMock()
    client.set.return_value = True
    monkeypatch.setattr(cache, "_get_sync_client", MagicMock(return_value=client))

    result = cache.set_from_sync("key", {"value": 1}, expire=60)

    assert result is True
    client.set.assert_called_once_with("key", orjson.dumps({"value": 1}), ex=60)


@pytest.mark.asyncio
async def test_aclose_closes_owned_pools_and_resets_clients() -> None:
    cache = RedisCache("redis://localhost:6379/0")
    async_client = AsyncMock()
    async_pool = AsyncMock()
    sync_client = MagicMock()
    sync_pool = MagicMock()
    cache._client = async_client
    cache._pool = async_pool
    cache._owner_loop = asyncio.get_running_loop()
    cache._sync_client = sync_client
    cache._sync_pool = sync_pool

    await cache.aclose()

    async_client.aclose.assert_awaited_once_with(close_connection_pool=False)
    async_pool.aclose.assert_awaited_once_with()
    sync_client.close.assert_called_once_with()
    sync_pool.disconnect.assert_called_once_with()
    assert cache._client is None
    assert cache._pool is None
    assert cache._owner_loop is None
    assert cache._sync_client is None
    assert cache._sync_pool is None
