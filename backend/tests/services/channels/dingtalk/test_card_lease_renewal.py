# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise real Redis lock scripts against the production script restriction."""

import asyncio
import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from redis.asyncio import Redis
from redis.asyncio.lock import Lock
from redis.exceptions import LockNotOwnedError, ResponseError

from app.services.channels.dingtalk import emitter


@pytest.mark.asyncio
@pytest.mark.parametrize("owned", [True, False])
async def test_renewal_resets_owned_lease_without_reading_ttl(monkeypatch, owned):
    timeout = 60
    client = Redis()
    lock = Lock(client, "card-lease", timeout=timeout)
    lock.local.token = b"owner-token"
    extend_sha = hashlib.sha1(Lock.LUA_EXTEND_SCRIPT.encode()).hexdigest()
    reacquire_sha = hashlib.sha1(Lock.LUA_REACQUIRE_SCRIPT.encode()).hexdigest()

    async def evalsha(sha, numkeys, name, token, *args):
        if sha == extend_sha:
            raise ResponseError(
                "Write commands not allowed after non deterministic commands"
            )
        assert (sha, numkeys, name, token, args) == (
            reacquire_sha,
            1,
            "card-lease",
            b"owner-token",
            (timeout * 1000,),
        )
        return int(owned)

    monkeypatch.setattr(client, "evalsha", AsyncMock(side_effect=evalsha))
    monkeypatch.setattr(
        emitter,
        "asyncio",
        SimpleNamespace(sleep=AsyncMock(side_effect=[None, asyncio.CancelledError()])),
    )
    renewal = emitter.StreamingResponseEmitter._renew_writer_lock(None, lock)
    try:
        if owned:
            with pytest.raises(asyncio.CancelledError):
                await renewal
        else:
            with pytest.raises(LockNotOwnedError):
                await renewal
        client.evalsha.assert_awaited_once()
    finally:
        await client.aclose()
