"""Batch writes never wait on one plugin while keeping another's lease."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from redis.exceptions import ConnectionError
from sqlalchemy.exc import TimeoutError

from app.models.kind import Kind
from app.services import plugin_write_coordination as coordination


@pytest.fixture
def parents(test_db):
    rows = [
        Kind(
            user_id=user,
            kind="InstalledPlugin",
            namespace="default",
            name="plugin",
            json={"spec": {"revision": 1}},
            is_active=True,
        )
        for user in (17, 18, 19)
    ]
    test_db.add_all(rows)
    test_db.commit()
    return [(row.user_id, row.id) for row in rows]


@pytest.fixture
def clock(monkeypatch):
    clock = SimpleNamespace(now=0.0)
    lease_type = coordination._Lease
    monkeypatch.setattr(
        coordination, "time", SimpleNamespace(monotonic=lambda: clock.now)
    )
    monkeypatch.setattr(
        coordination, "_Lease", lambda lock: lease_type(lock=lock, started=clock.now)
    )
    return clock


def test_batch_sorts_targets_and_never_waits_holding_other_leases(
    test_db, plugin_write_backend, parents, monkeypatch, clock
):
    attempts = []
    make_lock = plugin_write_backend.lock
    read = coordination.read_plugin_revisions

    def acquire(name, **options):
        attempts.append((name, options["blocking_timeout"]))
        return make_lock(name, **options)

    def claim(db, user, name):
        result = read(db, user, name)
        clock.now += 0.5
        return result

    monkeypatch.setattr(plugin_write_backend, "lock", acquire)
    monkeypatch.setattr(coordination, "read_plugin_revisions", claim)
    coordination.acquire_plugin_write_locks(
        test_db, [parents[2], parents[0], parents[2], parents[1]]
    )
    assert attempts == [
        (f"wegent:plugin-write:{user}:plugin", 0) for user in (17, 18, 19)
    ]
    test_db.commit()
    assert not plugin_write_backend.values
    assert test_db.query(Kind).filter_by(kind="ConnectorAuthPolicy").count() == 0


def test_batch_claims_share_one_overall_deadline(
    test_db, plugin_write_backend, parents, monkeypatch, clock
):
    read = coordination.read_plugin_revisions
    attempted = []

    def slow_claim(db, user, name):
        attempted.append(user)
        result = read(db, user, name)
        clock.now += 2
        return result

    monkeypatch.setattr(coordination, "read_plugin_revisions", slow_claim)
    with pytest.raises(coordination.PluginWriteError, match="plugin_write_busy"):
        coordination.acquire_plugin_write_locks(test_db, parents)
    assert attempted == [17, 18]
    assert not plugin_write_backend.values


def test_final_claim_cannot_admit_work_after_deadline(
    test_db, plugin_write_backend, parents, monkeypatch, clock
):
    read = coordination.read_plugin_revisions

    def slow_claim(db, user, name):
        result = read(db, user, name)
        clock.now += coordination.WAIT_SECONDS + 0.1
        return result

    monkeypatch.setattr(coordination, "read_plugin_revisions", slow_claim)
    with pytest.raises(coordination.PluginWriteError, match="plugin_write_busy"):
        coordination.acquire_plugin_write_locks(test_db, parents[:1])
    assert not plugin_write_backend.values


@pytest.mark.parametrize("failure", ["busy", "redis", "claim"])
def test_failed_batch_releases_every_acquired_plugin(
    test_db, plugin_write_backend, parents, monkeypatch, failure
):
    make_lock = plugin_write_backend.lock
    read = coordination.read_plugin_revisions

    def acquire(name, **options):
        if name == "wegent:plugin-write:18:plugin":
            if failure == "busy":
                return Mock(acquire=Mock(return_value=False))
            if failure == "redis":
                raise ConnectionError()
        return make_lock(name, **options)

    def claim(db, user, name):
        if user == 18 and failure == "claim":
            raise TimeoutError()
        return read(db, user, name)

    monkeypatch.setattr(plugin_write_backend, "lock", acquire)
    monkeypatch.setattr(coordination, "read_plugin_revisions", claim)
    with pytest.raises(coordination.PluginWriteError) as caught:
        coordination.acquire_plugin_write_locks(test_db, parents)
    assert caught.value.code == (
        "plugin_write_busy" if failure == "busy" else "plugin_write_unavailable"
    )
    assert not plugin_write_backend.values
    assert coordination._LEASES not in test_db.info
