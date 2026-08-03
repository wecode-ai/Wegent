# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Generic Redis-based distributed lock.

This is a dependency-free reimplementation of
``executor_manager.common.distributed_lock.DistributedLock``: it does NOT
hard-wire any Redis factory, so it can be imported from any service
(backend, knowledge_runtime, ...). Callers inject the ``redis.Redis``
client they already own (e.g. the same broker Redis Celery uses).

Usage::

    lock = DistributedLock(redis_client=redis.from_url(url))
    if lock.acquire("kb_stat:lock:2026-06-28", expire_seconds=1800):
        try:
            do_critical_work()
        finally:
            lock.release("kb_stat:lock:2026-06-28")

The lock uses ``SET key value NX EX seconds`` for atomic acquire + TTL, so
a holder crash auto-releases the lock after ``expire_seconds`` instead of
deadlocking.
"""

from __future__ import annotations

import logging
import secrets
from typing import Optional

import redis

logger = logging.getLogger(__name__)

# Lock owners are random tokens so release() can verify ownership before
# deleting, preventing a slow holder from releasing a lock already
# re-acquired by another instance after expiry.
_RELEASE_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
"""


class DistributedLock:
    """Redis-based distributed lock backed by ``SET NX EX``.

    Each lock name maps to a holder-specific token. ``acquire`` returns a
    token on success (truthy) and ``None`` on failure; pass the token back
    to ``release`` for safe, ownership-checked deletion.
    """

    def __init__(self, redis_client: Optional[redis.Redis] = None) -> None:
        self._redis_client = redis_client
        self._release_script = (
            self._redis_client.register_script(_RELEASE_SCRIPT)
            if self._redis_client is not None
            else None
        )

    @property
    def redis_client(self) -> Optional[redis.Redis]:
        """Lazy-load the Redis client if one was never injected."""
        return self._redis_client

    def acquire(self, lock_name: str, expire_seconds: int = 60) -> Optional[str]:
        """Try to acquire ``lock_name``.

        Returns a holder token on success, ``None`` if already held or the
        Redis client is unavailable.
        """
        if self._redis_client is None:
            logger.debug("[DistributedLock] no redis client, skip lock %s", lock_name)
            return None

        token = secrets.token_hex(8)
        try:
            # SET key token NX EX seconds — only set if not exists, with TTL.
            result = self._redis_client.set(
                lock_name, token, nx=True, ex=expire_seconds
            )
            if result is True:
                return token
            return None
        except Exception as e:  # noqa: BLE001 - degrade open, never crash caller
            logger.error("[DistributedLock] acquire %s failed: %s", lock_name, e)
            return None

    def release(self, lock_name: str, token: Optional[str]) -> bool:
        """Release ``lock_name`` only if still owned by ``token``.

        Returns True on successful release, False otherwise (including when
        no token / client is available, so callers can unconditionally call
        it from a ``finally`` block).
        """
        if self._redis_client is None or token is None or self._release_script is None:
            return False
        try:
            return bool(self._release_script(keys=[lock_name], args=[token]))
        except Exception as e:  # noqa: BLE001
            logger.error("[DistributedLock] release %s failed: %s", lock_name, e)
            return False


_lock_instance: Optional[DistributedLock] = None


def get_distributed_lock(redis_client: Optional[redis.Redis] = None) -> DistributedLock:
    """Get a process-wide ``DistributedLock`` singleton.

    The first caller may inject a ``redis_client``; subsequent callers get
    the same instance. Re-injecting a client is allowed (e.g. on reconnect)
    but normally callers just pass it once at startup.
    """
    global _lock_instance
    if _lock_instance is None or (
        _lock_instance.redis_client is None and redis_client is not None
    ):
        _lock_instance = DistributedLock(redis_client=redis_client)
    return _lock_instance
