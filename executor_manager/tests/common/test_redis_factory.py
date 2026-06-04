# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from executor_manager.common.config import RedisConfig
from executor_manager.common.redis_factory import RedisClientFactory


def test_create_sync_client_uses_resp2_protocol_by_default(mocker):
    """Redis clients must remain compatible with Redis servers without HELLO."""
    from_url = mocker.patch("executor_manager.common.redis_factory.redis.from_url")
    config = RedisConfig(url="redis://redis:6379/0")

    RedisClientFactory._create_sync_client(config)

    assert from_url.call_args.kwargs["protocol"] == 2


def test_create_async_client_uses_resp2_protocol_by_default(mocker):
    """Async Redis clients must use the same protocol as sync clients."""
    from_url = mocker.patch("executor_manager.common.redis_factory.aioredis.from_url")
    config = RedisConfig(url="redis://redis:6379/0")

    RedisClientFactory._create_async_client(config)

    assert from_url.call_args.kwargs["protocol"] == 2
