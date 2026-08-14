# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for owner-scoped Redis distributed locks."""

import pytest

from executor_manager.common.distributed_lock import (
    LOCK_KEY_PREFIX,
    DistributedLock,
    DistributedLockUnavailableError,
)
from executor_manager.common.redis_factory import RedisClientFactory


class _FakeRedis:
    def __init__(self):
        self.values = {}

    def set(self, key, value, *, nx=False, ex=None):
        del ex
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    def eval(self, script, key_count, key, *args):
        del key_count
        owner_token = args[0]
        if self.values.get(key) != owner_token:
            return 0
        if "expire" in script:
            return 1
        if "del" in script:
            del self.values[key]
            return 1
        raise AssertionError("unexpected lock script")


def test_owned_lock_does_not_release_a_new_owner():
    """An expired owner must not delete a lock reacquired by another process."""
    redis = _FakeRedis()
    lock = DistributedLock(redis)
    lock_name = "task-lifecycle:123"
    old_owner = lock.acquire_owned(lock_name, expire_seconds=60)
    assert old_owner

    key = f"{LOCK_KEY_PREFIX}{lock_name}"
    redis.values.pop(key)
    new_owner = lock.acquire_owned(lock_name, expire_seconds=60)
    assert new_owner and new_owner != old_owner

    assert lock.release_owned(lock_name, old_owner) is False
    assert redis.values[key] == new_owner
    assert lock.release_owned(lock_name, new_owner) is True
    assert key not in redis.values


def test_owned_lock_renews_only_the_current_owner():
    """Lease renewal must compare the owner token atomically."""
    redis = _FakeRedis()
    lock = DistributedLock(redis)
    lock_name = "task-lifecycle:123"
    owner = lock.acquire_owned(lock_name, expire_seconds=60)
    assert owner

    assert lock.renew_owned(lock_name, "stale-owner", expire_seconds=60) is False
    assert lock.renew_owned(lock_name, owner, expire_seconds=60) is True


def test_owned_lock_fails_closed_without_redis(monkeypatch):
    """Lifecycle callers must not proceed without cross-replica exclusion."""
    monkeypatch.setattr(RedisClientFactory, "get_sync_client", lambda: None)
    lock = DistributedLock()

    with pytest.raises(DistributedLockUnavailableError):
        lock.acquire_owned("task-lifecycle:123")
