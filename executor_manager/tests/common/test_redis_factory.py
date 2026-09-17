# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio

import pytest

from executor_manager.common.config import RedisConfig
from executor_manager.common.redis_factory import RedisClientFactory


def test_create_sync_client_uses_bounded_blocking_pool(mocker):
    """Sync Redis commands should wait briefly instead of failing at capacity."""
    pool = mocker.MagicMock()
    from_url = mocker.patch(
        "executor_manager.common.redis_factory.redis.BlockingConnectionPool.from_url",
        return_value=pool,
    )
    redis_client = mocker.patch("executor_manager.common.redis_factory.redis.Redis")
    config = RedisConfig(url="redis://redis:6379/0")

    RedisClientFactory._create_sync_client(config)

    from_url.assert_called_once_with(
        "redis://redis:6379/0",
        max_connections=100,
        timeout=2.0,
        encoding="utf-8",
        decode_responses=True,
        socket_timeout=30.0,
        socket_connect_timeout=3.0,
        protocol=2,
    )
    redis_client.assert_called_once_with(connection_pool=pool)


def test_create_async_client_uses_larger_bounded_blocking_pool(mocker):
    """Heartbeat traffic should use the larger async pool and short I/O timeout."""
    pool = mocker.MagicMock()
    from_url = mocker.patch(
        "executor_manager.common.redis_factory.aioredis.BlockingConnectionPool.from_url",
        return_value=pool,
    )
    redis_client = mocker.patch("executor_manager.common.redis_factory.aioredis.Redis")
    config = RedisConfig(url="redis://redis:6379/0")

    RedisClientFactory._create_async_client(config)

    from_url.assert_called_once_with(
        "redis://redis:6379/0",
        max_connections=200,
        timeout=2.0,
        encoding="utf-8",
        decode_responses=True,
        socket_timeout=5.0,
        socket_connect_timeout=3.0,
        protocol=2,
    )
    redis_client.assert_called_once_with(connection_pool=pool)


def test_redis_pool_limits_can_be_overridden(monkeypatch):
    monkeypatch.setenv("REDIS_SYNC_MAX_CONNECTIONS", "120")
    monkeypatch.setenv("REDIS_ASYNC_MAX_CONNECTIONS", "240")
    monkeypatch.setenv("REDIS_POOL_WAIT_TIMEOUT", "1.5")

    config = RedisConfig()

    assert config.sync_max_connections == 120
    assert config.async_max_connections == 240
    assert config.pool_wait_timeout == 1.5


def test_redis_pool_limits_must_be_positive(monkeypatch):
    monkeypatch.setenv("REDIS_ASYNC_MAX_CONNECTIONS", "0")

    with pytest.raises(
        ValueError, match="REDIS_ASYNC_MAX_CONNECTIONS must be greater than 0"
    ):
        RedisConfig()


@pytest.mark.asyncio
async def test_concurrent_async_initialization_creates_one_client(mocker):
    client = mocker.MagicMock()
    client.ping = mocker.AsyncMock(return_value=True)
    create_client = mocker.patch.object(
        RedisClientFactory,
        "_create_async_client",
        return_value=client,
    )

    clients = await asyncio.gather(
        *(RedisClientFactory.get_async_client() for _ in range(20))
    )

    assert clients == [client] * 20
    create_client.assert_called_once()
    client.ping.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_failed_async_verification_closes_candidate(mocker):
    client = mocker.MagicMock()
    client.ping = mocker.AsyncMock(side_effect=ConnectionError("unavailable"))
    client.aclose = mocker.AsyncMock()
    mocker.patch.object(
        RedisClientFactory,
        "_create_async_client",
        return_value=client,
    )
    RedisClientFactory._config = RedisConfig(max_retries=1)

    result = await RedisClientFactory.get_async_client()

    assert result is None
    client.aclose.assert_awaited_once_with(close_connection_pool=True)


@pytest.mark.asyncio
async def test_close_releases_cached_connection_pools(mocker):
    sync_client = mocker.MagicMock()
    async_client = mocker.MagicMock()
    async_client.aclose = mocker.AsyncMock()
    RedisClientFactory._sync_client = sync_client
    RedisClientFactory._async_client = async_client

    await RedisClientFactory.close()

    sync_client.close.assert_called_once_with()
    sync_client.connection_pool.disconnect.assert_called_once_with()
    async_client.aclose.assert_awaited_once_with(close_connection_pool=True)
    assert RedisClientFactory._sync_client is None
    assert RedisClientFactory._async_client is None
