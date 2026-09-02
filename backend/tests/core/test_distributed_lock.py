# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock

from app.core import distributed_lock as lock_module


def test_sync_redis_lock_pool_and_waits_are_bounded(monkeypatch) -> None:
    client = Mock()
    constructor = Mock(return_value=client)
    monkeypatch.setattr(lock_module.redis, "from_url", constructor)
    lock = lock_module.DistributedLock()

    assert lock.redis_client is client
    constructor.assert_called_once_with(
        lock_module.settings.CELERY_BROKER_URL or lock_module.settings.REDIS_URL,
        decode_responses=True,
        max_connections=lock_module.LOCK_REDIS_MAX_CONNECTIONS,
        socket_timeout=lock_module.LOCK_REDIS_COMMAND_TIMEOUT_SECONDS,
        socket_connect_timeout=lock_module.LOCK_REDIS_CONNECT_TIMEOUT_SECONDS,
    )
    client.ping.assert_called_once_with()


def test_async_redis_lock_pool_and_waits_are_bounded(monkeypatch) -> None:
    client = object()
    constructor = Mock(return_value=client)
    monkeypatch.setattr(lock_module.AsyncRedis, "from_url", constructor)
    lock = lock_module.DistributedLock()

    assert lock.async_redis_client is client
    constructor.assert_called_once_with(
        lock_module.settings.CELERY_BROKER_URL or lock_module.settings.REDIS_URL,
        decode_responses=True,
        max_connections=lock_module.LOCK_REDIS_MAX_CONNECTIONS,
        socket_timeout=lock_module.LOCK_REDIS_COMMAND_TIMEOUT_SECONDS,
        socket_connect_timeout=lock_module.LOCK_REDIS_CONNECT_TIMEOUT_SECONDS,
    )
