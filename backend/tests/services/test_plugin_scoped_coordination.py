"""Installation fences isolate plugins without invalidating runtime intents."""

from copy import deepcopy

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.models.plugin_state import PluginState
from app.schemas.device import DeviceCapabilitySyncResponse, DeviceCapabilitySyncResult
from app.services.device import plugin_sync_recording
from app.services.device.plugin_sync_protocol import (
    lock_installed_plugin_state,
    lock_plugin_sync_state,
)
from app.services.plugin_device_installation_service import (
    PluginDeviceInstallationService,
)
from app.services.plugin_kind_revision import replace_installed_kind
from app.services.plugin_write_coordination import acquire_plugin_write_lock
from app.services.plugin_write_errors import PluginWriteError


@pytest.fixture
def scoped_db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'scoped-plugin.db'}")
    Kind.__table__.create(engine)
    PluginState.__table__.create(engine)
    with Session(engine) as db:
        yield db
    engine.dispose()


def installation(db: Session, name: str) -> int:
    row = Kind(
        user_id=913,
        kind="InstalledPlugin",
        namespace="default",
        name=name,
        json={"spec": {"revision": 7, "enabled": True}},
        is_active=True,
    )
    db.add(row)
    db.commit()
    return row.id


@pytest.mark.parametrize("single_device", [True, False])
def test_ack_merges_metadata_without_retry_or_losing_another_device(
    scoped_db, plugin_write_backend, monkeypatch, single_device
):
    bind = scoped_db.get_bind()
    PluginDeviceInstallation.__table__.create(bind)
    installed_id = installation(scoped_db, "removed")
    parent = scoped_db.get(Kind, installed_id)
    parent.is_active = False
    scoped_db.add(
        PluginDeviceInstallation(
            user_id=913,
            installed_kind_id=installed_id,
            device_id="device",
            state="uninstalling",
        )
    )
    scoped_db.commit()
    state = lock_plugin_sync_state(scoped_db, 913)
    scoped_db.commit()
    state_id = state.id
    advance = plugin_sync_recording.advance_plugin_snapshot_watermark
    attempts = []

    def concurrent_ack(state, device_id, **kwargs):
        attempts.append(device_id)
        if len(attempts) == 1:
            with Session(bind) as other:
                row = other.get(PluginState, state_id)
                document = deepcopy(row.json)
                document["spec"].update(
                    revision=document["spec"].get("revision", 0) + 1,
                    devices={"peer": {"complete_generation": 11}},
                )
                row.json = document
                other.commit()
        advance(state, device_id, **kwargs)

    monkeypatch.setattr(
        plugin_sync_recording, "advance_plugin_snapshot_watermark", concurrent_ack
    )
    payload = {
        "mode": "merge",
        "scope": "plugin_delta",
        "plugins": [],
        "removed_plugins": [{"installed_plugin_id": installed_id}],
        "plugin_sync": {"version": 2, "generation": 7, "complete": False},
    }
    result = DeviceCapabilitySyncResult(
        device_id="device", success=True, desired_plugin_snapshot=payload
    )
    service = PluginDeviceInstallationService()
    if single_device:
        service.record_device_sync_result(scoped_db, user_id=913, result=result)
    else:
        service.record_sync_response(
            scoped_db,
            user_id=913,
            response=DeviceCapabilitySyncResponse(results=[result]),
        )

    assert attempts == ["device"]
    assert scoped_db.query(PluginDeviceInstallation).count() == 0
    parent = scoped_db.get(Kind, installed_id)
    assert parent.is_active is False
    assert parent.json["spec"]["writeRevision"] == 1
    devices = scoped_db.get(PluginState, state_id).json["spec"]["devices"]
    assert devices["peer"]["complete_generation"] == 11
    assert devices["device"]["plugins"][str(installed_id)] == 7
    assert not plugin_write_backend.values


def test_different_plugins_do_not_share_a_redis_lease(
    scoped_db, plugin_write_backend, monkeypatch
):
    first = installation(scoped_db, "first")
    second = installation(scoped_db, "second")
    bind = scoped_db.get_bind()
    with Session(bind) as one, Session(bind) as two, Session(bind) as contender:
        acquire_plugin_write_lock(one, 913, installed_id=first)
        acquire_plugin_write_lock(two, 913, installed_id=second)
        assert set(plugin_write_backend.values) == {
            "wegent:plugin-write:913:first",
            "wegent:plugin-write:913:second",
        }
        monkeypatch.setattr("app.services.plugin_write_coordination.WAIT_SECONDS", 0)
        with pytest.raises(PluginWriteError) as failure:
            acquire_plugin_write_lock(contender, 913, installed_id=first)
        assert failure.value.code == "plugin_write_busy"
    assert not plugin_write_backend.values


def test_authentication_advances_only_its_installation_fence(scoped_db):
    installed_id = installation(scoped_db, "auth-parent")
    acquire_plugin_write_lock(scoped_db, 913, installed_id=installed_id)
    scoped_db.add(
        Kind(
            user_id=913,
            kind="ConnectorConnection",
            namespace="plugin-auth",
            name="connection",
            json={"spec": {"installedPluginId": installed_id}},
        )
    )
    scoped_db.commit()
    parent = scoped_db.get(Kind, installed_id)
    assert parent.json["spec"]["writeRevision"] == 1
    assert parent.json["spec"]["revision"] == 7
    assert (
        scoped_db.query(Kind)
        .filter_by(
            user_id=913,
            kind="ConnectorAuthPolicy",
            namespace="plugin-auth",
            name="account",
        )
        .count()
        == 0
    )

    assert (
        scoped_db.query(Kind)
        .filter_by(
            user_id=913,
            kind="PluginSyncState",
            namespace="plugin-sync",
            name="account",
        )
        .count()
        == 0
    )


def test_savepoint_rollback_restores_parent_fence_for_auth_only_commit(scoped_db):
    installed_id = installation(scoped_db, "rollback-parent")
    acquire_plugin_write_lock(scoped_db, 913, installed_id=installed_id)
    parent = scoped_db.get(Kind, installed_id)
    nested = scoped_db.begin_nested()
    replace_installed_kind(scoped_db, parent, {"spec": {"enabled": False}})
    nested.rollback()
    scoped_db.add(
        Kind(
            user_id=913,
            kind="ConnectorConnection",
            namespace="plugin-auth",
            name="after-rollback",
            json={"spec": {"installedPluginId": installed_id}},
        )
    )
    scoped_db.commit()

    scoped_db.refresh(parent)
    assert parent.json["spec"] == {
        "revision": 7,
        "enabled": True,
        "writeRevision": 1,
    }


def test_rolled_back_sync_write_cannot_replace_desired_state_fence(scoped_db):
    installed_id = installation(scoped_db, "rollback-sync")
    state = lock_installed_plugin_state(scoped_db, 913, installed_id)
    scoped_db.commit()
    acquire_plugin_write_lock(scoped_db, 913, installed_id=installed_id)
    nested = scoped_db.begin_nested()
    state = lock_installed_plugin_state(scoped_db, 913, installed_id, merge=True)
    state.json = {**state.json, "rolledBack": True}
    scoped_db.flush()
    nested.rollback()
    parent = scoped_db.get(Kind, installed_id)
    replace_installed_kind(scoped_db, parent, {"spec": {"enabled": False}})
    scoped_db.commit()

    scoped_db.refresh(state)
    assert state.json["spec"]["revision"] == 1
    assert "rolledBack" not in state.json


def test_lease_loss_after_combined_content_cas_still_rolls_back(scoped_db):
    installed_id = installation(scoped_db, "lost-after-write")
    acquire_plugin_write_lock(scoped_db, 913, installed_id=installed_id)
    parent = scoped_db.get(Kind, installed_id)
    replace_installed_kind(scoped_db, parent, {"spec": {"enabled": False}})
    scoped_db.info["plugin_write_leases"][(913, parent.name)].lost.set()
    with pytest.raises(PluginWriteError, match="plugin_write_lease_lost"):
        scoped_db.commit()
    scoped_db.rollback()

    scoped_db.refresh(parent)
    assert parent.json["spec"] == {"revision": 7, "enabled": True}
    assert (
        scoped_db.query(Kind)
        .filter_by(
            user_id=913,
            kind="PluginSyncState",
            namespace="plugin-sync",
            name="account",
        )
        .count()
        == 0
    )


def test_stale_install_payload_cannot_reset_an_authentication_fence(
    scoped_db, plugin_write_backend
):
    installed_id = installation(scoped_db, "stale-parent")
    bind = scoped_db.get_bind()
    with Session(bind) as expired, Session(bind) as successor:
        acquire_plugin_write_lock(expired, 913, installed_id=installed_id)
        old = expired.get(Kind, installed_id)
        payload = deepcopy(old.json)
        plugin_write_backend.values.clear()
        acquire_plugin_write_lock(successor, 913, installed_id=installed_id)
        successor.commit()
        assert successor.get(Kind, installed_id).json["spec"]["revision"] == 7
        with pytest.raises(PluginWriteError) as failure:
            replace_installed_kind(expired, old, payload, is_active=False)
        assert failure.value.code == "plugin_write_conflict"
        expired.rollback()
    scoped_db.expire_all()
    parent = scoped_db.get(Kind, installed_id)
    assert parent.is_active is True
    assert parent.json["spec"]["writeRevision"] == 1


def test_shared_sync_document_rejects_stale_overwrites(scoped_db):
    with Session(scoped_db.get_bind()) as setup:
        lock_plugin_sync_state(setup, 913)
        setup.commit()
    with Session(scoped_db.get_bind()) as one, Session(scoped_db.get_bind()) as two:
        first = lock_plugin_sync_state(one, 913)
        second = lock_plugin_sync_state(two, 913)
        first.json = {**first.json, "first": "preserved"}
        one.commit()
        second.json = {**second.json, "second": "stale"}
        with pytest.raises(PluginWriteError):
            two.commit()
        two.rollback()
    with Session(scoped_db.get_bind()) as fresh:
        state = lock_plugin_sync_state(fresh, 913)
        assert state.json["first"] == "preserved"
        assert "second" not in state.json


def test_independent_intents_merge_without_losing_each_others_paths(scoped_db):
    with Session(scoped_db.get_bind()) as setup:
        lock_plugin_sync_state(setup, 913)
        setup.commit()
    with Session(scoped_db.get_bind()) as one, Session(scoped_db.get_bind()) as two:
        first = lock_plugin_sync_state(one, 913, merge=True)
        second = lock_plugin_sync_state(two, 913, merge=True)
        first.json = {
            **first.json,
            "spec": {
                **first.json["spec"],
                "localIntents": {
                    "desktop": {"11": {"operationId": "first", "revision": 3}}
                },
            },
        }
        second.json = {
            **second.json,
            "spec": {
                **second.json["spec"],
                "localIntents": {
                    "desktop": {"22": {"operationId": "second", "revision": 4}}
                },
            },
        }
        one.commit()
        two.commit()
    with Session(scoped_db.get_bind()) as fresh:
        state = lock_plugin_sync_state(fresh, 913)
        assert state.json["spec"]["localIntents"]["desktop"] == {
            "11": {"operationId": "first", "revision": 3},
            "22": {"operationId": "second", "revision": 4},
        }
        assert state.json["spec"]["revision"] == 2


def test_desired_mutation_invalidates_an_older_snapshot_generation(scoped_db):
    installed_id = installation(scoped_db, "snapshot-parent")
    with Session(scoped_db.get_bind()) as setup:
        lock_installed_plugin_state(setup, 913, installed_id)
        setup.commit()
    with (
        Session(scoped_db.get_bind()) as snapshot,
        Session(scoped_db.get_bind()) as writer,
    ):
        old_state = lock_installed_plugin_state(snapshot, 913, installed_id)
        old_content = snapshot.get(Kind, installed_id).json
        acquire_plugin_write_lock(writer, 913, installed_id=installed_id)
        parent = writer.get(Kind, installed_id)
        changed = deepcopy(parent.json)
        changed["spec"]["version"] = "new"
        replace_installed_kind(writer, parent, changed)
        writer.commit()
        assert old_content["spec"].get("version") != "new"
        old_state.json = {
            **old_state.json,
            "spec": {**old_state.json["spec"], "generation": 1},
        }
        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            snapshot.commit()
        snapshot.rollback()
    with Session(scoped_db.get_bind()) as fresh:
        state = lock_installed_plugin_state(fresh, 913, installed_id)
        assert state.json["spec"]["generation"] == 0
        assert fresh.get(Kind, installed_id).json["spec"]["version"] == "new"


def test_expired_first_creator_cannot_restore_a_successors_uninstall(
    scoped_db, plugin_write_backend
):
    lock_plugin_sync_state(scoped_db, 913, plugin_key="first-create")
    scoped_db.commit()
    bind = scoped_db.get_bind()
    with Session(bind) as expired, Session(bind) as successor:
        acquire_plugin_write_lock(expired, 913, name="first-create")
        expired.info["plugin_write_leases"][(913, "first-create")].check = lambda: None
        plugin_write_backend.values.clear()
        acquire_plugin_write_lock(successor, 913, name="first-create")
        parent = Kind(
            user_id=913,
            kind="InstalledPlugin",
            namespace="default",
            name="first-create",
            json={"spec": {"revision": 1}},
            is_active=True,
        )
        successor.add(parent)
        successor.commit()
        acquire_plugin_write_lock(successor, 913, installed_id=parent.id)
        replace_installed_kind(
            successor,
            parent,
            {"spec": {"installState": "uninstalled"}},
            is_active=False,
        )
        successor.commit()
        expired.add(
            Kind(
                user_id=913,
                kind="InstalledPlugin",
                namespace="default",
                name="first-create",
                json={"spec": {}},
                is_active=True,
            )
        )
        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            expired.commit()
        expired.rollback()
    with Session(bind) as fresh:
        rows = (
            fresh.query(Kind)
            .filter_by(
                user_id=913,
                kind="InstalledPlugin",
                namespace="default",
                name="first-create",
            )
            .all()
        )
        assert len(rows) == 1 and rows[0].is_active is False
        assert rows[0].json["spec"]["installState"] == "uninstalled"


def test_independent_first_creators_compare_only_their_own_slot(scoped_db):
    for name in ("new-a", "new-b"):
        lock_plugin_sync_state(scoped_db, 913, plugin_key=name)
    scoped_db.commit()
    bind = scoped_db.get_bind()
    with Session(bind) as first, Session(bind) as second:
        for db, name in ((first, "new-a"), (second, "new-b")):
            acquire_plugin_write_lock(db, 913, name=name)
        for db, name in ((first, "new-a"), (second, "new-b")):
            db.add(
                Kind(
                    user_id=913,
                    kind="InstalledPlugin",
                    namespace="default",
                    name=name,
                    json={"spec": {}},
                    is_active=True,
                )
            )
            db.commit()
    with Session(bind) as fresh:
        for name in ("new-a", "new-b"):
            state = lock_plugin_sync_state(fresh, 913, plugin_key=name)
            assert state.json["spec"]["creationRevisions"] == {name: 1}


@pytest.mark.parametrize("complete", [False, True])
def test_new_dispatch_before_commit_rejects_an_obsolete_failed_ack(
    scoped_db, plugin_write_backend, monkeypatch, complete
):
    from app.services.device.capability_sync_service import (
        device_capability_sync_service,
    )

    bind = scoped_db.get_bind()
    PluginDeviceInstallation.__table__.create(bind)
    installed_id = installation(scoped_db, "ack-fence")
    parent = scoped_db.get(Kind, installed_id)
    parent.json = {"spec": {**parent.json["spec"], "releaseId": 2}}
    scoped_db.add(
        PluginDeviceInstallation(
            user_id=913,
            installed_kind_id=installed_id,
            device_id="device",
            desired_release_id=2,
            actual_release_id=1,
            state="failed",
            attempt_count=2,
        )
    )
    scoped_db.commit()
    state = lock_plugin_sync_state(scoped_db, 913)
    scoped_db.commit()
    state_id = state.id
    desired = {"installed_plugin_id": installed_id, "version": "2.0.0"}
    monkeypatch.setattr(
        device_capability_sync_service,
        "_load_installed_plugins",
        lambda *args, **kwargs: [desired],
    )
    advance = plugin_sync_recording.advance_plugin_snapshot_watermark
    attempts = []

    def dispatch_before_commit(state, device_id, **kwargs):
        attempts.append(device_id)
        if len(attempts) == 1:
            with Session(bind) as dispatch:
                row = dispatch.get(PluginState, state_id)
                document = deepcopy(row.json)
                device = (
                    {"complete_generation": 8}
                    if complete
                    else {"plugins": {str(installed_id): 8}}
                )
                document["spec"].update(
                    revision=document["spec"].get("revision", 0) + 1,
                    generation=8,
                    devices={"device": device},
                )
                row.json = document
                dispatch.commit()
        advance(state, device_id, **kwargs)

    monkeypatch.setattr(
        plugin_sync_recording,
        "advance_plugin_snapshot_watermark",
        dispatch_before_commit,
    )
    result = DeviceCapabilitySyncResult(
        device_id="device",
        success=False,
        error="obsolete failure",
        plugins=[{"id": installed_id, "status": "failed"}],
        desired_plugin_snapshot={
            "plugins": [desired],
            "plugin_sync": {"version": 2, "generation": 7, "complete": False},
        },
    )
    service = PluginDeviceInstallationService()
    service.record_device_sync_result(scoped_db, user_id=913, result=result)
    row = scoped_db.query(PluginDeviceInstallation).one()
    assert attempts == ["device", "device"]
    assert row.attempt_count == 2
    assert row.actual_release_id == 1
    current = result.model_copy(deep=True)
    current.success = True
    current.error = None
    current.plugins[0].status = "synced"
    current.desired_plugin_snapshot["plugin_sync"]["generation"] = 8
    service.record_device_sync_result(scoped_db, user_id=913, result=current)
    row = scoped_db.query(PluginDeviceInstallation).one()
    assert row.state == "installed"
    assert row.actual_release_id == 2
    assert not plugin_write_backend.values


def test_catalog_rename_invalidates_a_paused_first_creator(
    scoped_db, plugin_write_backend, monkeypatch
):
    installed_id = installation(scoped_db, "old-name")
    lock_installed_plugin_state(scoped_db, 913, installed_id)
    lock_plugin_sync_state(scoped_db, 913, plugin_key="canonical")
    scoped_db.commit()
    with Session(scoped_db.get_bind()) as expired:
        acquire_plugin_write_lock(expired, 913, name="canonical")
        for lease in expired.info["plugin_write_leases"].values():
            monkeypatch.setattr(lease, "check", lambda: None)
        plugin_write_backend.values.clear()
        acquire_plugin_write_lock(scoped_db, 913, installed_id=installed_id)
        parent = scoped_db.get(Kind, installed_id)
        replace_installed_kind(scoped_db, parent, parent.json, name="canonical")
        scoped_db.commit()
        expired.add(
            Kind(
                user_id=913,
                kind="InstalledPlugin",
                namespace="default",
                name="canonical",
                json={"spec": {}},
                is_active=True,
            )
        )
        with pytest.raises(PluginWriteError, match="plugin_write_conflict"):
            expired.commit()
        expired.rollback()
    scoped_db.expire_all()
    assert scoped_db.query(Kind).filter_by(kind="InstalledPlugin").count() == 1
    state = scoped_db.query(PluginState).filter_by(plugin_key="canonical").one()
    assert state.installed_kind_id == installed_id


def test_plugin_mutation_does_not_write_an_existing_legacy_aggregate(scoped_db):
    installed_id = installation(scoped_db, "independent")
    legacy = lock_plugin_sync_state(scoped_db, 913)
    scoped_db.commit()
    original = deepcopy(legacy.json)
    acquire_plugin_write_lock(scoped_db, 913, installed_id=installed_id)
    parent = scoped_db.get(Kind, installed_id)
    replace_installed_kind(scoped_db, parent, {"spec": {"enabled": False}})
    scoped_db.commit()
    scoped_db.refresh(legacy)
    assert legacy.json == original


def test_catalog_rename_keeps_retired_receipts_and_the_live_identity(scoped_db):
    old_id = installation(scoped_db, "old-alias")
    retired_id = installation(scoped_db, "canonical")
    acquire_plugin_write_lock(scoped_db, 913, installed_id=retired_id)
    parent = scoped_db.get(Kind, retired_id)
    replace_installed_kind(scoped_db, parent, parent.json, is_active=False)
    state = lock_installed_plugin_state(scoped_db, 913, retired_id)
    document = deepcopy(state.json)
    document["spec"].update(
        generation=50,
        localIntents={
            "native": {
                str(retired_id): {"operationId": "old-request", "intentOrder": 9}
            }
        },
    )
    state.json = document
    scoped_db.commit()
    acquire_plugin_write_lock(scoped_db, 913, installed_id=old_id)
    parent = scoped_db.get(Kind, old_id)
    replace_installed_kind(scoped_db, parent, parent.json, name="canonical")
    scoped_db.commit()
    states = {
        state.installed_kind_id: state for state in scoped_db.query(PluginState).all()
    }
    assert states[old_id].plugin_key == "canonical"
    assert states[old_id].json["spec"]["generation"] == 50
    assert states[retired_id].plugin_key.startswith("@retired:")
    assert (
        states[retired_id].json["spec"]["localIntents"]["native"][str(retired_id)][
            "operationId"
        ]
        == "old-request"
    )


@pytest.mark.parametrize(
    "legacy_watermark,revision,expected",
    [(None, 11, True), (None, 12, False), (9999, 12, False)],
)
def test_requesting_device_recovery_compares_its_scoped_acknowledgement(
    scoped_db, legacy_watermark, revision, expected
):
    from app.schemas.device import DeviceCapabilitySyncResponse
    from app.services.plugin_device_sync import _plugin_ack_needs_reconciliation

    PluginDeviceInstallation.__table__.create(scoped_db.get_bind())
    installed_id = installation(scoped_db, "scoped-recovery")
    state = lock_installed_plugin_state(scoped_db, 913, installed_id)
    document = deepcopy(state.json)
    document["spec"].update(
        generation=12, devices={"device": {"plugins": {str(installed_id): 12}}}
    )
    state.json = document
    scoped_db.add(
        PluginDeviceInstallation(
            user_id=913,
            installed_kind_id=installed_id,
            device_id="device",
            state="pending",
        )
    )
    if legacy_watermark is not None:
        legacy = lock_plugin_sync_state(scoped_db, 913)
        document = deepcopy(legacy.json)
        document["spec"]["devices"] = {
            "device": {"complete_generation": legacy_watermark}
        }
        legacy.json = document
    scoped_db.commit()
    payload = {
        "plugins": [{"installed_plugin_id": installed_id}],
        "plugin_sync": {
            "version": 3,
            "generation": 100,
            "complete": False,
            "revisions": {str(installed_id): revision},
            "intentRevisions": {str(installed_id): 7},
        },
    }
    result = DeviceCapabilitySyncResult(
        device_id="device", success=True, desired_plugin_snapshot=payload
    )
    assert (
        _plugin_ack_needs_reconciliation(
            scoped_db,
            user_id=913,
            device_id="device",
            installed_id=installed_id,
            response=DeviceCapabilitySyncResponse(results=[result]),
        )
        is expected
    )
    if legacy_watermark is None:
        assert (
            scoped_db.query(PluginState).filter_by(plugin_key="@legacy-v2").count() == 0
        )


@pytest.mark.parametrize("aggregate", [False, True])
def test_scoped_ack_recording_never_initializes_account_metadata(
    scoped_db, monkeypatch, aggregate
):
    from app.schemas.device import DeviceCapabilitySyncResponse
    from app.services.device.capability_sync_service import (
        device_capability_sync_service,
    )
    from app.services.plugin_kind_revision import kind_revision

    PluginDeviceInstallation.__table__.create(scoped_db.get_bind())
    installed_id = installation(scoped_db, "scoped-record")
    acquire_plugin_write_lock(scoped_db, 913, installed_id=installed_id)
    parent = scoped_db.get(Kind, installed_id)
    replace_installed_kind(
        scoped_db, parent, {"spec": {**parent.json["spec"], "releaseId": 1}}
    )
    scoped_db.commit()
    desired = {
        "installed_plugin_id": installed_id,
        "name": "scoped-record",
        "version": "1.0",
    }
    monkeypatch.setattr(
        device_capability_sync_service,
        "_load_installed_plugins",
        lambda *args, **kwargs: [desired],
    )
    payload = {
        "plugins": [desired],
        "plugin_sync": {
            "version": 3,
            "generation": 1,
            "complete": False,
            "revisions": {str(installed_id): 1},
            "intentRevisions": {str(installed_id): kind_revision(parent)},
        },
    }
    result = DeviceCapabilitySyncResult(
        device_id="device",
        success=True,
        desired_plugin_snapshot=payload,
        plugins=[{"id": installed_id, "status": "synced", "generation": 1}],
    )
    service = PluginDeviceInstallationService()
    if aggregate:
        service.record_sync_response(
            scoped_db,
            user_id=913,
            response=DeviceCapabilitySyncResponse(results=[result]),
        )
    else:
        service.record_device_sync_result(scoped_db, user_id=913, result=result)
    assert scoped_db.query(PluginDeviceInstallation).one().state == "installed"
    assert (
        scoped_db.query(PluginState)
        .filter_by(user_id=913, plugin_key="@legacy-v2")
        .count()
        == 0
    )
