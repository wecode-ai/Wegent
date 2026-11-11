"""Installation fences isolate plugins without invalidating runtime intents."""

from copy import deepcopy

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResponse, DeviceCapabilitySyncResult
from app.services.device import plugin_sync_recording
from app.services.device.plugin_sync_protocol import lock_plugin_sync_state
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
                row = other.get(Kind, state_id)
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
    devices = scoped_db.get(Kind, state_id).json["spec"]["devices"]
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
        lock_plugin_sync_state(setup, 913)
        setup.commit()
    with (
        Session(scoped_db.get_bind()) as snapshot,
        Session(scoped_db.get_bind()) as writer,
    ):
        old_state = lock_plugin_sync_state(snapshot, 913)
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
        state = lock_plugin_sync_state(fresh, 913)
        assert state.json["spec"]["generation"] == 0
        assert fresh.get(Kind, installed_id).json["spec"]["version"] == "new"


def test_expired_first_creator_cannot_restore_a_successors_uninstall(
    scoped_db, plugin_write_backend
):
    lock_plugin_sync_state(scoped_db, 913)
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
    lock_plugin_sync_state(scoped_db, 913)
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
        state = lock_plugin_sync_state(fresh, 913)
        assert state.json["spec"]["creationRevisions"] == {"new-a": 1, "new-b": 1}


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
                row = dispatch.get(Kind, state_id)
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
