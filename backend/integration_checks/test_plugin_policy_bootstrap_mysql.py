"""First policy creation and optimistic versions with real MySQL and Redis."""

from dataclasses import replace

import pytest
from sqlalchemy import text

from app.models.kind import Kind
from app.services import plugin_policy_revision as policies
from app.services import plugin_write_coordination as coordination
from app.services.plugin_write_coordination import (
    acquire_plugin_write_lock,
    configure_auth_policy,
)
from app.services.plugin_write_errors import PluginWriteError
from integration_checks.plugin_auth_fixtures import context, sessions


def policy_query(db, user_id):
    return db.query(Kind).filter(
        Kind.user_id == user_id,
        Kind.kind == "ConnectorAuthPolicy",
        Kind.namespace == "plugin-auth",
        Kind.name == "account",
    )


def add_policy(db, user_id, *, payload, active=True):
    row = Kind(
        user_id=user_id,
        kind="ConnectorAuthPolicy",
        namespace="plugin-auth",
        name="account",
        json=payload,
        is_active=active,
    )
    db.add(row)
    db.flush()
    return row.id


def assert_unlocked(context):
    assert not coordination._redis_client().exists(
        f"wegent:plugin-write:{context.user_id}"
    )


def test_first_policy_remains_committed_after_outer_business_rollback(context):
    with context.sessions() as db:
        acquire_plugin_write_lock(db, context.user_id)
        expected = policies.read_policy_revision(db, context.user_id)
        db.add(
            Kind(
                user_id=context.user_id,
                kind="ConnectorLocalAuthPolicy",
                namespace="plugin-auth",
                name="rolled-back",
                json={"spec": {"enabled": False}},
            )
        )
        db.flush()
        db.rollback()
    assert_unlocked(context)
    with context.sessions() as db:
        row = policy_query(db, context.user_id).one()
        assert row.id == expected.row_id
        assert row.json == {"spec": {"enabled": True, "revision": 0}}
        assert (
            db.query(Kind)
            .filter_by(user_id=context.user_id, name="rolled-back")
            .count()
            == 0
        )
    with context.sessions.begin() as db:
        acquire_plugin_write_lock(db, context.user_id)
    assert_unlocked(context)
    with context.sessions() as db:
        assert policy_query(db, context.user_id).one().json["spec"]["revision"] == 1


def test_initialization_sql_failure_rolls_back_and_releases_the_lease(
    context, monkeypatch
):
    original = policies._initialize_default

    def fail_after_insert(db, user_id):
        original(db, user_id)
        db.execute(text("SELECT id FROM missing_plugin_policy_bootstrap_test_table"))

    with monkeypatch.context() as patch:
        patch.setattr(policies, "_initialize_default", fail_after_insert)
        with context.sessions() as db:
            with pytest.raises(PluginWriteError, match="plugin_write_unavailable"):
                acquire_plugin_write_lock(db, context.user_id)
            db.rollback()
    assert_unlocked(context)
    with context.sessions() as db:
        assert policy_query(db, context.user_id).count() == 0
    with context.sessions.begin() as db:
        acquire_plugin_write_lock(db, context.user_id)
    assert_unlocked(context)
    with context.sessions() as db:
        assert policy_query(db, context.user_id).count() == 1


def test_first_coordinated_write_preserves_an_inactive_disabled_policy(context):
    payload = {
        "spec": {"enabled": False, "revision": 7},
        "metadata": {"keep": True},
    }
    with context.sessions.begin() as db:
        row_id = add_policy(db, context.user_id, payload=payload, active=False)
    with context.sessions.begin() as db:
        acquire_plugin_write_lock(db, context.user_id)
        expected = policies.read_policy_revision(db, context.user_id)
        assert expected.row_id == row_id and expected.revision == 7
    with context.sessions() as db:
        row = policy_query(db, context.user_id).one()
        assert row.id == row_id and row.is_active is True
        assert row.json == {
            "spec": {"enabled": False, "revision": 8},
            "metadata": {"keep": True},
        }
    assert_unlocked(context)


def test_duplicate_policies_are_rejected_without_selecting_a_preference(context):
    with context.sessions.begin() as db:
        for enabled in (False, True):
            add_policy(
                db,
                context.user_id,
                payload={"spec": {"enabled": enabled, "revision": 2}},
                active=enabled,
            )
    with context.sessions() as db:
        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            acquire_plugin_write_lock(db, context.user_id)
        db.rollback()
    with context.sessions() as db:
        rows = policy_query(db, context.user_id).order_by(Kind.id).all()
        assert [row.json for row in rows] == [
            {"spec": {"enabled": False, "revision": 2}},
            {"spec": {"enabled": True, "revision": 2}},
        ]
        assert [row.is_active for row in rows] == [False, True]
    assert_unlocked(context)


@pytest.mark.parametrize("revision", [None, True, "0", -1, 2**63 - 1])
def test_invalid_policy_revision_rejects_write_and_releases_lease(context, revision):
    payload = {"spec": {"enabled": False, "revision": revision}}
    with context.sessions.begin() as db:
        add_policy(db, context.user_id, payload=payload, active=False)
    with context.sessions() as db:
        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            acquire_plugin_write_lock(db, context.user_id)
        db.rollback()
    with context.sessions() as db:
        row = policy_query(db, context.user_id).one()
        assert row.json == payload and row.is_active is False
    assert_unlocked(context)


def test_stale_parent_cas_cannot_restore_a_disabled_preference(context):
    with context.sessions.begin() as db:
        acquire_plugin_write_lock(db, context.user_id)
        stale = replace(policies.read_policy_revision(db, context.user_id))
        configure_auth_policy(db, context.user_id, False)
    with context.sessions() as db:
        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            policies.advance_policy_revision(db, stale, enabled=True)
        db.rollback()
    with context.sessions() as db:
        assert policy_query(db, context.user_id).one().json["spec"] == {
            "enabled": False,
            "revision": 2,
        }
