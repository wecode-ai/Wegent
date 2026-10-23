"""Strict owned locks coexist with the scheduler's availability policy."""

from unittest.mock import Mock

import pytest
from redis import Redis
from redis.exceptions import ConnectionError

from app.core.distributed_lock import (
    DistributedLock,
    DistributedLockUnavailableError,
)


def test_owned_lock_rejects_unavailable_redis_without_changing_legacy_policy(
    monkeypatch,
):
    monkeypatch.setattr(DistributedLock, "redis_client", property(lambda _: None))
    locks = DistributedLock()

    with pytest.raises(DistributedLockUnavailableError):
        locks.owned_lock("wegent:plugin-write:17", expire_seconds=30)

    assert locks.acquire("scheduler-task", expire_seconds=30) is True


def test_owned_lock_uses_explicit_client_without_loading_scheduler_redis(monkeypatch):
    def unexpected_client(_):
        raise AssertionError("The scheduler Redis must not be used for plugin writes")

    monkeypatch.setattr(DistributedLock, "redis_client", property(unexpected_client))
    with Redis(host="unused.test") as client:
        lock = DistributedLock().owned_lock(
            "wegent:plugin-write:17",
            expire_seconds=30,
            blocking_timeout=0,
            redis_client=client,
        )

        assert lock.redis is client
        assert lock.name == "wegent:plugin-write:17"


def test_owned_lock_propagates_redis_failure_instead_of_granting_ownership(monkeypatch):
    with Redis(host="unused.test") as client:
        monkeypatch.setattr(client, "set", Mock(side_effect=ConnectionError("offline")))
        lock = DistributedLock().owned_lock(
            "wegent:plugin-write:17", expire_seconds=30, redis_client=client
        )

        with pytest.raises(ConnectionError):
            lock.acquire(token="owner-token")
