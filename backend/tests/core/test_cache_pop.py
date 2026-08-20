# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import orjson
import pytest

from app.core.cache import RedisCache


@pytest.mark.asyncio
async def test_pop_atomically_gets_and_deletes_cached_json(monkeypatch):
    cache = RedisCache("redis://localhost:6379/0")
    client = AsyncMock()
    client.getdel.return_value = orjson.dumps({"value": "one-time"})
    monkeypatch.setattr(cache, "_get_client", AsyncMock(return_value=client))

    result = await cache.pop("oauth:one-time")

    assert result == {"value": "one-time"}
    client.getdel.assert_awaited_once_with("oauth:one-time")
    client.aclose.assert_awaited_once()
