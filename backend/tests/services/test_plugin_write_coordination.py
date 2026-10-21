"""Lease lifetime and stale-writer protection at real Session boundaries."""

import threading
from unittest.mock import Mock

import pytest
from redis.exceptions import ConnectionError
from sqlalchemy.exc import TimeoutError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services import plugin_write_coordination as coordination


def test_lock_is_reentrant_until_root_commit(test_db, plugin_write_backend):
    redis, _ = plugin_write_backend
    coordination.acquire_plugin_write_lock(test_db, 17)
    original = redis.values["wegent:plugin-write:17"][0]

    coordination.acquire_plugin_write_lock(test_db, 17)

    assert redis.values["wegent:plugin-write:17"][0] == original
    test_db.commit()
    assert "wegent:plugin-write:17" not in redis.values


@pytest.mark.parametrize("finish", ["rollback", "close"])
def test_transaction_cleanup_releases_lease(test_db, plugin_write_backend, finish):
    redis, _ = plugin_write_backend
    coordination.acquire_plugin_write_lock(test_db, 17)

    getattr(test_db, finish)()

    assert "wegent:plugin-write:17" not in redis.values


@pytest.mark.parametrize("finish", ["commit", "rollback"])
def test_savepoint_end_keeps_root_lease(test_db, plugin_write_backend, finish):
    redis, _ = plugin_write_backend
    coordination.acquire_plugin_write_lock(test_db, 17)
    nested = test_db.begin_nested()

    getattr(nested, finish)()

    assert "wegent:plugin-write:17" in redis.values
    test_db.rollback()
    assert not redis.values


def test_other_user_can_write_while_same_user_is_busy(
    test_db, plugin_write_backend, monkeypatch
):
    monkeypatch.setattr(coordination, "WAIT_SECONDS", 0)
    coordination.acquire_plugin_write_lock(test_db, 17)
    with Session(
        test_db.connection(), join_transaction_mode="create_savepoint"
    ) as other:
        coordination.acquire_plugin_write_lock(other, 18)
        with pytest.raises(coordination.PluginWriteError) as caught:
            coordination.acquire_plugin_write_lock(other, 17)
        assert caught.value.code == "plugin_write_busy"
        assert caught.value.status_code == 503
    assert "wegent:plugin-write:17" in plugin_write_backend[0].values


def test_redis_failure_prevents_reading_policy(test_db, monkeypatch):
    claim = Mock()
    monkeypatch.setattr(coordination, "read_policy_revision", claim)
    monkeypatch.setattr(
        coordination, "_redis_client", Mock(side_effect=ConnectionError("private"))
    )

    with pytest.raises(coordination.PluginWriteError) as caught:
        coordination.acquire_plugin_write_lock(test_db, 17)

    assert caught.value.code == "plugin_write_unavailable"
    assert "private" not in str(caught.value)
    claim.assert_not_called()


def test_claim_failure_releases_acquired_lease(
    test_db, plugin_write_backend, monkeypatch
):
    monkeypatch.setattr(
        coordination,
        "read_policy_revision",
        Mock(side_effect=RuntimeError("claim failed")),
    )

    with pytest.raises(RuntimeError, match="claim failed"):
        coordination.acquire_plugin_write_lock(test_db, 17)

    assert not plugin_write_backend[0].values


def test_policy_bootstrap_timeout_is_a_safe_retryable_error(
    test_db, plugin_write_backend, monkeypatch
):
    monkeypatch.setattr(
        coordination, "read_policy_revision", Mock(side_effect=TimeoutError("private"))
    )

    with pytest.raises(coordination.PluginWriteError) as caught:
        coordination.acquire_plugin_write_lock(test_db, 17)

    assert caught.value.code == "plugin_write_unavailable"
    assert caught.value.headers == {"Cache-Control": "no-store"}
    assert not plugin_write_backend[0].values


def test_superseded_revision_rejects_commit_even_when_redis_reports_owned(
    test_db, plugin_write_backend
):
    coordination.acquire_plugin_write_lock(test_db, 17)
    policy = test_db.query(Kind).filter_by(user_id=17).one()
    policy.json = {"spec": {"enabled": False, "revision": 1}}
    test_db.flush()

    with pytest.raises(coordination.PluginWriteError) as caught:
        test_db.commit()

    assert caught.value.code == "plugin_write_conflict"
    test_db.rollback()
    assert not plugin_write_backend[0].values


def test_lost_lease_cannot_be_reacquired_by_same_transaction(
    test_db, plugin_write_backend
):
    redis, _ = plugin_write_backend
    coordination.acquire_plugin_write_lock(test_db, 17)
    redis.values.pop("wegent:plugin-write:17")

    with pytest.raises(coordination.PluginWriteError, match="plugin_write_lease_lost"):
        coordination.acquire_plugin_write_lock(test_db, 17)
    with pytest.raises(coordination.PluginWriteError, match="plugin_write_lease_lost"):
        test_db.commit()


def test_failed_renewal_permanently_invalidates_lease(monkeypatch):
    lock = Mock()
    lock.reacquire.side_effect = ConnectionError()
    lease = coordination._Lease(lock, "token")
    monkeypatch.setattr(coordination, "RENEW_SECONDS", 0.001)
    worker = threading.Thread(target=lease.renew)
    worker.start()

    assert lease.lost.wait(1)
    worker.join(timeout=1)
    lock.owned.return_value = True
    with pytest.raises(coordination.PluginWriteError, match="plugin_write_lease_lost"):
        lease.check()


def test_failed_release_does_not_report_successful_commit_as_failure(
    test_db, monkeypatch
):
    coordination.acquire_plugin_write_lock(test_db, 17)
    lease = test_db.info[coordination._LEASES][17]
    monkeypatch.setattr(lease.lock, "release", Mock(side_effect=ConnectionError()))

    test_db.commit()

    assert coordination._LEASES not in test_db.info


def test_configure_policy_retains_its_cas_version(test_db):
    coordination.configure_auth_policy(test_db, 17, False)
    coordination.configure_auth_policy(test_db, 17, True)

    test_db.commit()

    policy = test_db.query(Kind).filter_by(user_id=17).one()
    assert policy.json == {"spec": {"enabled": True, "revision": 3}}


@pytest.mark.parametrize("inner_commit", [False, True])
def test_savepoint_rollback_restores_expected_policy_revision(test_db, inner_commit):
    coordination.acquire_plugin_write_lock(test_db, 17)
    outer = test_db.begin_nested()
    inner = test_db.begin_nested()
    coordination.configure_auth_policy(test_db, 17, False)
    if inner_commit:
        inner.commit()
    else:
        inner.rollback()
    outer.rollback()

    test_db.commit()

    policy = test_db.query(Kind).filter_by(user_id=17).one()
    assert policy.json == {"spec": {"enabled": True, "revision": 1}}


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {"spec": None},
        {"spec": []},
        {"spec": {"revision": "1"}},
        {"spec": {"revision": True}},
        {"spec": {"revision": -1}},
        {"spec": {"revision": 2**63 - 1}},
    ],
)
def test_invalid_parent_payload_cannot_bypass_revision(test_db, payload):
    test_db.add(
        Kind(
            user_id=17,
            kind="ConnectorAuthPolicy",
            namespace="plugin-auth",
            name="account",
            json=payload,
        )
    )
    test_db.flush()

    with pytest.raises(coordination.PluginWriteError, match="plugin_write_conflict"):
        coordination.acquire_plugin_write_lock(test_db, 17)


def test_existing_policy_without_revision_keeps_disabled_preference(test_db):
    test_db.add(
        Kind(
            user_id=17,
            kind="ConnectorAuthPolicy",
            namespace="plugin-auth",
            name="account",
            json={"spec": {"enabled": False}},
        )
    )
    test_db.flush()

    coordination.acquire_plugin_write_lock(test_db, 17)
    test_db.commit()

    policy = test_db.query(Kind).filter_by(user_id=17).one()
    assert policy.json == {"spec": {"enabled": False, "revision": 1}}


def test_inactive_policy_row_is_reactivated_with_its_preference(test_db):
    test_db.add(
        Kind(
            user_id=17,
            kind="ConnectorAuthPolicy",
            namespace="plugin-auth",
            name="account",
            json={"spec": {"enabled": False, "revision": 3}},
            is_active=False,
        )
    )
    test_db.flush()

    coordination.acquire_plugin_write_lock(test_db, 17)
    test_db.commit()

    policy = test_db.query(Kind).filter_by(user_id=17).one()
    assert policy.is_active is True
    assert policy.json == {"spec": {"enabled": False, "revision": 4}}


def test_expired_operation_deadline_rejects_commit(test_db, plugin_write_backend):
    coordination.acquire_plugin_write_lock(test_db, 17)
    lease = test_db.info[coordination._LEASES][17]
    lease.started -= coordination.OPERATION_SECONDS + 1

    with pytest.raises(coordination.PluginWriteError) as caught:
        test_db.commit()

    assert caught.value.code == "plugin_write_lease_lost"
    test_db.rollback()
    assert not plugin_write_backend[0].values
