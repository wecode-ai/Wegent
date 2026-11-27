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


@pytest.mark.parametrize("body_fails", [False, True])
def test_owned_lease_release_transport_error_preserves_body_outcome(
    monkeypatch, body_fails
):
    lease = Mock()
    lease.acquire.return_value = True
    lease.release.side_effect = ConnectionError("release unavailable")
    locks = DistributedLock()
    monkeypatch.setattr(locks, "owned_lock", lambda *a, **kw: lease)
    if body_fails:
        with pytest.raises(ValueError, match="original failure"):
            with locks.owned_watchdog_context("document"):
                raise ValueError("original failure")
    else:
        with locks.owned_watchdog_context("document") as acquired:
            assert acquired is lease
    lease.release.assert_called_once()


@pytest.mark.parametrize("interval", [0, -1])
def test_owned_watchdog_rejects_nonpositive_interval_before_redis(
    monkeypatch, interval
):
    locks = DistributedLock()
    acquire = Mock()
    monkeypatch.setattr(locks, "owned_lock", acquire)

    with pytest.raises(ValueError, match="interval must be positive"):
        with locks.owned_watchdog_context("document", extend_interval_seconds=interval):
            pytest.fail("Invalid interval must not start a watchdog")

    acquire.assert_not_called()
