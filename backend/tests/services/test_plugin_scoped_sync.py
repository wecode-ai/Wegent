"""Plugin-scoped protocol never advances unrelated plugin or account state."""

from copy import deepcopy

import pytest

from app.models.kind import Kind
from app.models.plugin_state import PluginState
from app.services.device.plugin_change_sync import validate_ack
from app.services.device.plugin_sync_protocol import (
    load_versioned_plugin_payload,
    plugin_sync_version,
    register_plugin_snapshot_intent,
)
from tests.services.test_plugin_sync_protocol import snapshot_sessions  # noqa: F401


def seed(sessions, name, *, active=True):
    with sessions.begin() as db:
        row = Kind(
            user_id=1,
            kind="InstalledPlugin",
            namespace="default",
            name=name,
            is_active=active,
            json={"spec": {"revision": 7, "version": "1.0.0"}},
        )
        db.add(row)
        db.flush()
        return row.id


def snapshot(sessions, ids, *, complete=False):
    def load(db):
        rows = db.query(Kind).filter(Kind.id.in_(ids), Kind.is_active.is_(True)).all()
        return {
            "mode": "merge",
            "scope": "plugins" if complete else "plugin_delta",
            "plugins": [
                {"installed_plugin_id": row.id, "name": row.name, "version": "1.0.0"}
                for row in rows
            ],
        }

    return load_versioned_plugin_payload(
        sessions, user_id=1, load_payload=load, complete=complete, protocol_version=3
    )


def test_explicit_negotiation_prefers_scoped_protocol():
    assert (
        plugin_sync_version(
            {"pluginSync": {"protocolVersion": 2, "supportedVersions": [2, 3]}}
        )
        == 3
    )
    assert (
        plugin_sync_version(
            {"pluginSync": {"protocolVersion": 2, "supportedVersions": ["3", True]}}
        )
        == 2
    )
    assert plugin_sync_version({"pluginSync": {"protocolVersion": 4}}) is None


def test_independent_plugin_generations_and_device_intents(snapshot_sessions):
    alpha = seed(snapshot_sessions, "alpha")
    beta = seed(snapshot_sessions, "beta")
    first = snapshot(snapshot_sessions, [alpha])
    second = snapshot(snapshot_sessions, [alpha])
    other = snapshot(snapshot_sessions, [beta])
    assert first["plugin_sync"]["revisions"] == {str(alpha): 1}
    assert second["plugin_sync"]["revisions"] == {str(alpha): 2}
    assert other["plugin_sync"]["revisions"] == {str(beta): 1}
    assert second["plugin_sync"]["intentRevisions"] == {str(alpha): 7}
    for payload in (second, other):
        register_plugin_snapshot_intent(
            snapshot_sessions, user_id=1, device_id="desktop", payload=payload
        )
    with snapshot_sessions() as db:
        rows = {row.plugin_key: row for row in db.query(PluginState).all()}
        assert set(rows) == {"alpha", "beta"}
        assert rows["alpha"].json["spec"]["devices"]["desktop"]["plugins"] == {
            str(alpha): 2
        }
        assert rows["beta"].json["spec"]["devices"]["desktop"]["plugins"] == {
            str(beta): 1
        }
        assert db.query(Kind).filter_by(kind="PluginSyncState").count() == 0


def test_complete_snapshot_carries_explicit_tombstones_and_never_implicit_removal(
    snapshot_sessions,
):
    alpha = seed(snapshot_sessions, "alpha")
    beta = seed(snapshot_sessions, "beta", active=False)
    omitted = seed(snapshot_sessions, "unselected")
    payload = snapshot(snapshot_sessions, [alpha], complete=True)
    assert payload["plugin_sync"]["complete"] is False
    assert {p["installed_plugin_id"] for p in payload["removed_plugins"]} == {
        beta,
        omitted,
    }
    assert set(payload["plugin_sync"]["revisions"]) == {
        str(alpha),
        str(beta),
        str(omitted),
    }


def test_ack_uses_each_plugin_generation(snapshot_sessions):
    alpha = seed(snapshot_sessions, "alpha")
    beta = seed(snapshot_sessions, "beta")
    snapshot(snapshot_sessions, [alpha])
    payload = snapshot(snapshot_sessions, [alpha, beta])
    response = {
        "success": True,
        "scope": "plugin_delta",
        "plugin_sync": deepcopy(payload["plugin_sync"]),
        "plugins": [
            {
                "id": p["installed_plugin_id"],
                "status": "synced",
                "operation": "upsert",
                "version": p["version"],
                "generation": payload["plugin_sync"]["revisions"][
                    str(p["installed_plugin_id"])
                ],
            }
            for p in payload["plugins"]
        ],
    }
    assert validate_ack(payload, response) is None
    response["plugins"][1]["generation"] = payload["plugin_sync"]["generation"]
    assert (
        validate_ack(payload, response)
        == "Device returned an obsolete plugin acknowledgement"
    )


def test_new_plugin_inherits_legacy_cutover_floor_only_at_bootstrap(snapshot_sessions):
    from app.services.device.plugin_sync_protocol import lock_plugin_sync_state

    with snapshot_sessions.begin() as db:
        legacy = lock_plugin_sync_state(db, 1)
        legacy.json = {
            "spec": {"revision": 0, "generation": 100, "legacyActive": False}
        }
    alpha = seed(snapshot_sessions, "alpha")
    beta = seed(snapshot_sessions, "beta")
    assert snapshot(snapshot_sessions, [alpha])["plugin_sync"]["revisions"] == {
        str(alpha): 101
    }
    assert snapshot(snapshot_sessions, [beta])["plugin_sync"]["revisions"] == {
        str(beta): 101
    }
    with snapshot_sessions() as db:
        legacy = (
            db.query(PluginState).filter_by(user_id=1, plugin_key="@legacy-v2").one()
        )
        assert legacy.json == {
            "spec": {"revision": 1, "generation": 100, "legacyActive": False}
        }


def test_physical_parent_cleanup_keeps_an_explicit_device_tombstone(snapshot_sessions):
    identity = seed(snapshot_sessions, "retired")
    snapshot(snapshot_sessions, [identity])
    with snapshot_sessions.begin() as db:
        db.query(Kind).filter_by(id=identity).delete(synchronize_session=False)
    payload = snapshot(snapshot_sessions, [], complete=True)
    assert payload["removed_plugins"] == [
        {"installed_plugin_id": identity, "name": "retired", "marketplace": None}
    ]
    assert payload["plugin_sync"]["revisions"] == {str(identity): 2}
    register_plugin_snapshot_intent(
        snapshot_sessions, user_id=1, device_id="desktop", payload=payload
    )


def test_existing_plugin_advances_beyond_its_last_legacy_client_snapshot(
    snapshot_sessions,
):
    from app.services.device.plugin_sync_protocol import lock_plugin_sync_state

    identity = seed(snapshot_sessions, "upgrade-existing")
    snapshot(snapshot_sessions, [identity])
    with snapshot_sessions.begin() as db:
        legacy = lock_plugin_sync_state(db, 1)
        legacy.json = {"spec": {"revision": 0, "generation": 100}}
    legacy = load_versioned_plugin_payload(
        snapshot_sessions,
        user_id=1,
        protocol_version=2,
        complete=True,
        load_payload=lambda db: {
            "mode": "merge",
            "scope": "plugins",
            "plugins": [
                {
                    "installed_plugin_id": identity,
                    "name": "upgrade-existing",
                    "version": "1.0.0",
                }
            ],
        },
    )
    current = snapshot(snapshot_sessions, [identity])
    assert (
        current["plugin_sync"]["revisions"][str(identity)]
        > legacy["plugin_sync"]["generation"]
    )
