# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
import time
import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
import redis
import redis.asyncio as aioredis

from executor_manager.common.config import reset_config
from executor_manager.common.redis_factory import RedisClientFactory
from executor_manager.routers.routers import app
from executor_manager.services.heartbeat_manager import HeartbeatManager


@pytest.fixture
async def real_redis_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[str, None]:
    redis_url = os.getenv("E2E_REDIS_URL")
    if not redis_url:
        pytest.fail("E2E_REDIS_URL must point to a dedicated real Redis database")

    monkeypatch.setenv("REDIS_URL", redis_url)
    monkeypatch.setenv("REDIS_SYNC_MAX_CONNECTIONS", "2")
    monkeypatch.setenv("REDIS_ASYNC_MAX_CONNECTIONS", "2")
    monkeypatch.setenv("REDIS_POOL_WAIT_TIMEOUT", "0.2")
    monkeypatch.setenv("REDIS_CONNECT_TIMEOUT", "1")
    monkeypatch.setenv("REDIS_ASYNC_SOCKET_TIMEOUT", "1")
    reset_config()
    RedisClientFactory.reset()
    HeartbeatManager._instance = None

    try:
        yield redis_url
    finally:
        await RedisClientFactory.close()
        HeartbeatManager._instance = None
        reset_config()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_real_pool_exhaustion_returns_503_and_recovers(
    real_redis_pool: str,
) -> None:
    assert await RedisClientFactory.initialize()
    sync_client = RedisClientFactory._sync_client
    async_client = RedisClientFactory._async_client
    assert sync_client is not None
    assert async_client is not None
    assert isinstance(sync_client.connection_pool, redis.BlockingConnectionPool)
    assert isinstance(async_client.connection_pool, aioredis.BlockingConnectionPool)
    assert sync_client.connection_pool.max_connections == 2
    assert async_client.connection_pool.max_connections == 2
    assert async_client.connection_pool.timeout == 0.2

    pool = async_client.connection_pool
    held_connections = [
        await pool.get_connection(),
        await pool.get_connection(),
    ]
    heartbeat_id = f"redis-pool-e2e-{uuid.uuid4().hex}"
    heartbeat_key = f"task:heartbeat:{heartbeat_id}"
    control_client = aioredis.from_url(real_redis_pool, decode_responses=True)

    try:
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 12345))
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://executor-manager",
        ) as http_client:
            started_at = time.monotonic()
            exhausted_response = await http_client.post(
                f"/executor-manager/tasks/{heartbeat_id}/heartbeat"
            )
            exhausted_elapsed = time.monotonic() - started_at

            assert exhausted_response.status_code == 503
            assert exhausted_response.headers["Retry-After"] == "1"
            assert exhausted_elapsed < 1.0

            await pool.release(held_connections.pop())
            recovered_response = await http_client.post(
                f"/executor-manager/tasks/{heartbeat_id}/heartbeat"
            )

            assert recovered_response.status_code == 200
            assert recovered_response.json() == {
                "status": "ok",
                "task_id": heartbeat_id,
            }

        heartbeat_ttl = await control_client.ttl(heartbeat_key)
        assert 0 < heartbeat_ttl <= 60
    finally:
        await control_client.delete(heartbeat_key)
        await control_client.aclose()
        for connection in held_connections:
            await pool.release(connection)
