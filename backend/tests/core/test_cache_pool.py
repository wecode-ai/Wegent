# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Pool ownership must not leak connections or share them across event loops."""

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, Mock

import pytest
from redis.asyncio import Redis
from redis.exceptions import ConnectionError

from app.core.cache import RedisCache


@asynccontextmanager
async def managed_cache(cache):
    await cache.start()
    try:
        yield
    finally:
        await cache.aclose()


@pytest.fixture
def cache():
    return RedisCache("redis://localhost:6379/0")


@pytest.mark.asyncio
async def test_clients_share_pool_without_closing_it_between_operations(
    cache, monkeypatch
):
    async with managed_cache(cache):
        first = await cache._get_client()
        second = await cache._get_client()
        pool = first.connection_pool
        close = AsyncMock(wraps=pool.aclose)
        monkeypatch.setattr(pool, "aclose", close)

        assert first is second
        assert second.connection_pool is pool
        assert first.auto_close_connection_pool is False
        await first.aclose()
        await second.aclose()
        close.assert_not_awaited()

    close.assert_awaited_once()
    assert cache._pool is None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [ValueError, asyncio.CancelledError])
async def test_shutdown_closes_pool_even_on_failure(cache, monkeypatch, failure):
    with pytest.raises(failure):
        async with managed_cache(cache):
            client = await cache._get_client()
            close = AsyncMock(wraps=client.connection_pool.aclose)
            monkeypatch.setattr(client.connection_pool, "aclose", close)
            await client.aclose()
            raise failure()

    close.assert_awaited_once()
    assert cache._pool is None


@pytest.mark.asyncio
async def test_unmanaged_loop_client_owns_and_closes_its_pool(cache, monkeypatch):
    client = await cache._get_client()
    pool = client.connection_pool
    disconnect = AsyncMock(wraps=pool.disconnect)
    monkeypatch.setattr(pool, "disconnect", disconnect)
    assert client.auto_close_connection_pool is True
    await client.aclose()
    disconnect.assert_awaited_once()
    assert cache._pool is None


def test_sequential_event_loops_do_not_reuse_a_closed_pool(cache):
    async def use_pool():
        async with managed_cache(cache):
            client = await cache._get_client()
            pool = client.connection_pool
            await client.aclose()
            return pool

    first = asyncio.run(use_pool())
    second = asyncio.run(use_pool())
    assert first is not second
    assert cache._pool is None


@pytest.mark.asyncio
async def test_background_thread_does_not_borrow_backend_pool(cache):
    async with managed_cache(cache):
        backend = await cache._get_client()

        async def background():
            client = await cache._get_client()
            pool = client.connection_pool
            assert client.auto_close_connection_pool is True
            await client.aclose()
            return pool

        thread_pool = await asyncio.to_thread(lambda: asyncio.run(background()))
        assert thread_pool is not backend.connection_pool
        assert cache._pool is backend.connection_pool
        await backend.aclose()


@pytest.mark.asyncio
async def test_inherited_process_cannot_borrow_parent_pool(cache, monkeypatch):
    from app.core import cache as cache_module

    async with managed_cache(cache):
        parent = await cache._get_client()
        monkeypatch.setattr(cache_module.os, "getpid", lambda: -1)
        child = await cache._get_client()
        assert child.connection_pool is not parent.connection_pool
        assert child.auto_close_connection_pool is True
        await child.aclose()
        await parent.aclose()


@pytest.mark.asyncio
async def test_cache_api_retains_json_and_atomic_set_contract(cache, monkeypatch):
    execute = AsyncMock(side_effect=[b'{"task_id":101}', True, None])
    monkeypatch.setattr(Redis, "execute_command", execute)
    async with managed_cache(cache):
        assert await cache.get("card-a") == {"task_id": 101}
        assert await cache.setnx("event-a", {"pending": True}, expire=60)
        assert not await cache.setnx("event-a", {"pending": True}, expire=60)
    assert execute.call_args_list[0].args == ("GET", "card-a")
    assert execute.call_args_list[1].args == (
        "SET",
        "event-a",
        b'{"pending":true}',
        "EX",
        60,
        "NX",
    )


@pytest.mark.asyncio
async def test_sync_bridge_does_not_affect_backend_pool(cache, monkeypatch):
    monkeypatch.setattr(
        cache, "_get_sync_client", Mock(return_value=Mock(set=Mock(return_value=True)))
    )
    async with managed_cache(cache):
        backend = await cache._get_client()
        assert await asyncio.to_thread(cache.set_from_sync, "key", "value")
        assert cache._pool is backend.connection_pool
        following = await cache._get_client()
        assert following.connection_pool is backend.connection_pool
        await following.aclose()
        await backend.aclose()


@pytest.mark.asyncio
async def test_exhausted_pool_yields_to_other_tasks_and_times_out(cache, monkeypatch):
    async with managed_cache(cache):
        client = await cache._get_client()
        pool = client.connection_pool
        pool.timeout = 0.05
        monkeypatch.setattr(pool, "ensure_connection", AsyncMock())
        held = [await pool.get_connection() for _ in range(pool.max_connections)]
        try:
            waiting = asyncio.create_task(pool.get_connection())
            # Unrelated async work must run while the connection queue is full.
            progressed = asyncio.Event()

            async def unrelated_request():
                await asyncio.sleep(0)
                progressed.set()

            await asyncio.wait_for(unrelated_request(), timeout=1)
            assert progressed.is_set()
            with pytest.raises(ConnectionError, match="No connection available"):
                await asyncio.wait_for(waiting, timeout=1)
            assert len(pool._in_use_connections) == pool.max_connections
        finally:
            for connection in held:
                await pool.release(connection)
            await client.aclose()


@pytest.mark.asyncio
async def test_cancellation_while_connecting_returns_pool_capacity(cache, monkeypatch):
    async with managed_cache(cache):
        client = await cache._get_client()
        pool = client.connection_pool
        connecting = asyncio.Event()

        async def stalled_connection(connection):
            connecting.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(pool, "ensure_connection", stalled_connection)
        waiting = asyncio.create_task(pool.get_connection())
        await asyncio.wait_for(connecting.wait(), timeout=1)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        assert not pool._in_use_connections
        monkeypatch.setattr(pool, "ensure_connection", AsyncMock())
        recovered = await pool.get_connection()
        await pool.release(recovered)
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [ConnectionError, asyncio.CancelledError])
async def test_failed_subscription_closes_both_owned_objects(
    cache, monkeypatch, failure
):
    pubsub = Mock(subscribe=AsyncMock(side_effect=failure()), aclose=AsyncMock())
    client = Mock(pubsub=Mock(return_value=pubsub), aclose=AsyncMock())
    create = Mock(return_value=client)
    monkeypatch.setattr(Redis, "from_url", create)

    async with managed_cache(cache):
        with pytest.raises(failure):
            await cache.subscribe("stream:test")

    assert create.call_args.kwargs["max_connections"] == 1
    pubsub.aclose.assert_awaited_once()
    client.aclose.assert_awaited_once()
