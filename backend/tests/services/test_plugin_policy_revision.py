"""The account policy remains the common optimistic parent of plugin writes."""

from dataclasses import replace

import pytest

from app.models.kind import Kind
from app.services import plugin_policy_revision as policies
from app.services.plugin_write_errors import PluginWriteError


def policy_rows(db, user_id=17):
    return db.query(Kind).filter(
        Kind.user_id == user_id,
        Kind.kind == "ConnectorAuthPolicy",
        Kind.namespace == "plugin-auth",
        Kind.name == "account",
    )


def add_policy(db, **changes):
    row = Kind(
        **{
            "user_id": 17,
            "kind": "ConnectorAuthPolicy",
            "namespace": "plugin-auth",
            "name": "account",
            "json": {"spec": {"enabled": False, "revision": 2}},
            "is_active": True,
            **changes,
        }
    )
    db.add(row)
    db.flush()
    return row


def test_shared_kind_model_has_no_account_policy_unique_index():
    assert "uq_kinds_account_auth_policy" not in {
        index.name for index in Kind.__table__.indexes
    }


def test_first_policy_is_reused_without_creating_other_resources(test_db):
    before = test_db.query(Kind).count()

    first = policies.read_policy_revision(test_db, 17)
    policies._initialize_default(test_db, 17)
    second = policies.read_policy_revision(test_db, 17)

    assert first == second
    assert first.revision == 0
    assert policy_rows(test_db).one().json == {"spec": {"enabled": True, "revision": 0}}
    assert test_db.query(Kind).count() == before + 1


def test_policy_lookup_checks_the_complete_resource_identity(test_db):
    unrelated = [
        add_policy(test_db, user_id=18),
        add_policy(test_db, kind="OtherPolicy"),
        add_policy(test_db, namespace="other"),
        add_policy(test_db, name="other"),
    ]

    parent = policies.read_policy_revision(test_db, 17)

    assert parent.row_id not in {row.id for row in unrelated}
    assert policy_rows(test_db).one().json["spec"]["enabled"] is True
    assert all(row.json["spec"]["enabled"] is False for row in unrelated)


def test_inactive_policy_retains_disabled_preference_and_version(test_db):
    row = add_policy(
        test_db,
        is_active=False,
        json={"spec": {"enabled": False, "revision": 7}, "metadata": {"keep": True}},
    )

    expected = policies.read_policy_revision(test_db, 17)
    test_db.refresh(row)

    assert expected.row_id == row.id and expected.revision == 7
    assert row.is_active is True
    assert row.json == {
        "spec": {"enabled": False, "revision": 7},
        "metadata": {"keep": True},
    }


def test_legacy_policy_without_revision_keeps_its_preference(test_db):
    row = add_policy(test_db, json={"spec": {"enabled": False}})

    expected = policies.read_policy_revision(test_db, 17)

    assert expected.row_id == row.id and expected.revision == 0
    assert row.json == {"spec": {"enabled": False}}


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"spec": []},
        *[
            {"spec": {"enabled": False, "revision": revision}}
            for revision in (None, True, "0", -1, 2**63 - 1)
        ],
    ],
)
def test_invalid_policy_is_rejected_without_reactivation(test_db, payload):
    row = add_policy(test_db, json=payload, is_active=False)

    with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
        policies.read_policy_revision(test_db, 17)

    test_db.refresh(row)
    assert row.is_active is False
    assert row.json == payload


def test_duplicate_policies_fail_without_changing_either_preference(test_db):
    for enabled in (False, True):
        add_policy(
            test_db,
            is_active=enabled,
            json={"spec": {"enabled": enabled, "revision": 2}},
        )

    with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
        policies.read_policy_revision(test_db, 17)

    assert sorted(row.json["spec"]["enabled"] for row in policy_rows(test_db)) == [
        False,
        True,
    ]


def test_stale_policy_cas_cannot_restore_the_previous_preference(test_db):
    expected = policies.read_policy_revision(test_db, 17)
    stale = replace(expected)
    policies.advance_policy_revision(test_db, expected, enabled=False)

    with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
        policies.advance_policy_revision(test_db, stale, enabled=True)

    row = policy_rows(test_db).one()
    assert row.json == {"spec": {"enabled": False, "revision": 1}}
