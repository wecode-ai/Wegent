# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.models.user import User
from app.services.device.capability_sync_service import DeviceCapabilitySyncService
from app.services.device.plugin_sync_protocol import (
    advance_plugin_snapshot_watermark,
    load_versioned_plugin_payload,
    lock_plugin_sync_state,
    plugin_snapshot_watermark,
    register_plugin_snapshot_intent,
    supports_plugin_sync_v2,
)
from app.services.plugin_write_errors import PluginWriteError


@pytest.fixture
def snapshot_sessions(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'plugin-sync.db'}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    User.__table__.create(engine)
    Kind.__table__.create(engine)
    PluginDeviceInstallation.__table__.create(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add(User(id=1, user_name="owner", password_hash="unused"))
        db.add(User(id=2, user_name="other", password_hash="unused"))
        db.commit()
    yield factory
    engine.dispose()


def _load_empty(_db):
    return {"mode": "merge", "scope": "plugin_delta", "plugins": []}


@pytest.mark.parametrize(
    "features",
    [None, {}, [], {"pluginSync": None}, {"pluginSync": "2"}]
    + [{"pluginSync": {"protocolVersion": value}} for value in (None, True, "2", 1, 3)],
)
def test_legacy_and_malformed_features_never_enable_new_wire_protocol(features):
    assert supports_plugin_sync_v2(features) is False


def test_explicit_plugin_sync_feature_enables_new_wire_protocol():
    assert supports_plugin_sync_v2({"pluginSync": {"protocolVersion": 2}}) is True


def test_concurrent_snapshot_generations_are_durable_and_unique(snapshot_sessions):
    barrier = Barrier(8)

    def dispatch_snapshot(_index):
        barrier.wait(timeout=10)
        return load_versioned_plugin_payload(
            snapshot_sessions, user_id=1, load_payload=_load_empty, complete=False
        )["plugin_sync"]["generation"]

    with ThreadPoolExecutor(max_workers=8) as executor:
        generations = list(executor.map(dispatch_snapshot, range(8)))

    assert sorted(generations) == list(range(1, 9))
    with snapshot_sessions() as db:
        states = db.query(Kind).filter(Kind.kind == "PluginSyncState").all()
        assert len(states) == 1
        assert states[0].json["spec"]["generation"] == 8
    response = load_versioned_plugin_payload(
        snapshot_sessions, user_id=1, load_payload=_load_empty, complete=True
    )
    assert response["plugin_sync"] == {
        "version": 2,
        "generation": 9,
        "complete": True,
    }


def test_snapshot_reads_latest_committed_plugin_and_removal(snapshot_sessions):
    with snapshot_sessions() as db:
        plugin = Kind(
            user_id=1,
            kind="InstalledPlugin",
            namespace="default",
            name="demo",
            json={"spec": {"version": "1.0.0"}},
            is_active=True,
        )
        db.add(plugin)
        db.commit()
        plugin_id = plugin.id

    def load_target(db):
        current = db.query(Kind).filter(Kind.id == plugin_id).one()
        return {
            "mode": "merge",
            "scope": "plugin_delta",
            "plugins": (
                [{"installed_plugin_id": current.id, **current.json["spec"]}]
                if current.is_active
                else []
            ),
            "removed_plugins": (
                [] if current.is_active else [{"installed_plugin_id": current.id}]
            ),
        }

    original = load_versioned_plugin_payload(
        snapshot_sessions, user_id=1, load_payload=load_target, complete=False
    )
    with snapshot_sessions() as db:
        plugin = db.get(Kind, plugin_id)
        plugin.json = {"spec": {"version": "2.0.0"}}
        db.commit()
    updated = load_versioned_plugin_payload(
        snapshot_sessions, user_id=1, load_payload=load_target, complete=False
    )
    with snapshot_sessions() as db:
        plugin = db.get(Kind, plugin_id)
        plugin.is_active = False
        db.commit()
    removed = load_versioned_plugin_payload(
        snapshot_sessions, user_id=1, load_payload=load_target, complete=False
    )

    assert original["plugins"][0]["version"] == "1.0.0"
    assert updated["plugins"][0]["version"] == "2.0.0"
    assert removed["plugins"] == []
    assert removed["removed_plugins"] == [{"installed_plugin_id": plugin_id}]
    assert [
        item["plugin_sync"]["generation"] for item in (original, updated, removed)
    ] == [
        1,
        2,
        3,
    ]


def test_failed_snapshot_rolls_back_sequence_and_releases_lock(snapshot_sessions):
    def fail_loader(_db):
        raise RuntimeError("resolution failed")

    with pytest.raises(RuntimeError, match="resolution failed"):
        load_versioned_plugin_payload(
            snapshot_sessions, user_id=1, load_payload=fail_loader, complete=False
        )
    recovered = load_versioned_plugin_payload(
        snapshot_sessions, user_id=1, load_payload=_load_empty, complete=False
    )
    assert recovered["plugin_sync"]["generation"] == 1


@pytest.mark.parametrize("failure", ["lease_lost", "revision_conflict"])
def test_failed_coordination_rolls_back_generation_and_watermark(
    snapshot_sessions, plugin_write_backend, failure
):
    register_plugin_snapshot_intent(
        snapshot_sessions,
        user_id=1,
        device_id="device",
        payload=_intent(7, [123]),
    )

    def invalidate_coordination(db):
        state = db.query(Kind).filter_by(kind="PluginSyncState", user_id=1).one()
        advance_plugin_snapshot_watermark(
            state,
            "device",
            generation=8,
            complete=False,
            installed_plugin_ids=[456],
        )
        if failure == "lease_lost":
            plugin_write_backend.values.pop("wegent:plugin-write:1")
        else:
            policy = (
                db.query(Kind)
                .filter_by(
                    user_id=1,
                    kind="ConnectorAuthPolicy",
                    namespace="plugin-auth",
                    name="account",
                )
                .one()
            )
            document = deepcopy(policy.json)
            document["spec"]["revision"] += 1
            policy.json = document
            db.flush()
        return _load_empty(db)

    expected_error = (
        "plugin_write_lease_lost"
        if failure == "lease_lost"
        else "plugin_write_conflict"
    )
    with pytest.raises(PluginWriteError, match=expected_error):
        load_versioned_plugin_payload(
            snapshot_sessions,
            user_id=1,
            load_payload=invalidate_coordination,
            complete=False,
        )

    assert not plugin_write_backend.values
    with snapshot_sessions() as db:
        state = db.query(Kind).filter_by(kind="PluginSyncState", user_id=1).one()
        assert state.json["spec"]["generation"] == 7
        assert plugin_snapshot_watermark(state, "device", 123) == 7
        assert plugin_snapshot_watermark(state, "device", 456) == 0
        policy = db.query(Kind).filter_by(kind="ConnectorAuthPolicy", user_id=1).one()
        assert policy.json["spec"]["revision"] == 1

    recovered = load_versioned_plugin_payload(
        snapshot_sessions, user_id=1, load_payload=_load_empty, complete=False
    )
    assert recovered["plugin_sync"]["generation"] == 8


def test_generation_state_is_scoped_by_owner_namespace_and_name(snapshot_sessions):
    with snapshot_sessions() as db:
        for user_id, namespace, name in (
            (2, "plugin-sync", "account"),
            (1, "other", "account"),
            (1, "plugin-sync", "other"),
        ):
            db.add(
                Kind(
                    user_id=user_id,
                    kind="PluginSyncState",
                    namespace=namespace,
                    name=name,
                    json={"spec": {"generation": 100}},
                    is_active=True,
                )
            )
        db.commit()

    payload = load_versioned_plugin_payload(
        snapshot_sessions, user_id=1, load_payload=_load_empty, complete=False
    )
    assert payload["plugin_sync"]["generation"] == 1


def _intent(generation, ids=(), *, complete=False):
    return {
        "plugin_sync": {
            "version": 2,
            "generation": generation,
            "complete": complete,
        },
        "plugins": [{"installed_plugin_id": identity} for identity in ids],
    }


def test_snapshot_allocation_preserves_sent_intent_watermarks(snapshot_sessions):
    register_plugin_snapshot_intent(
        snapshot_sessions,
        user_id=1,
        device_id="device",
        payload=_intent(7, [123]),
    )

    payload = load_versioned_plugin_payload(
        snapshot_sessions, user_id=1, load_payload=_load_empty, complete=True
    )

    assert payload["plugin_sync"]["generation"] == 8
    with snapshot_sessions() as db:
        state = lock_plugin_sync_state(db, 1)
        assert plugin_snapshot_watermark(state, "device", 123) == 7
        assert plugin_snapshot_watermark(state, "device", 456) == 0


def test_sent_intents_keep_per_plugin_order_and_complete_floor(snapshot_sessions):
    for payload in (
        _intent(5, [123]),
        _intent(7, [456]),
        _intent(3, complete=True),
        _intent(4, [123]),
    ):
        register_plugin_snapshot_intent(
            snapshot_sessions, user_id=1, device_id="device", payload=payload
        )

    with snapshot_sessions() as db:
        state = lock_plugin_sync_state(db, 1)
        assert plugin_snapshot_watermark(state, "device", 123) == 5
        assert plugin_snapshot_watermark(state, "device", 456) == 7
        assert plugin_snapshot_watermark(state, "device", 789) == 3
        assert plugin_snapshot_watermark(state, "other-device", 123) == 0


def test_registration_uses_canonical_owned_device_alias(snapshot_sessions):
    with snapshot_sessions() as db:
        db.add(
            Kind(
                user_id=1,
                kind="Device",
                namespace="default",
                name="runtime-device",
                is_active=True,
                json={
                    "spec": {
                        "deviceType": "remote",
                        "deviceId": "runtime-device",
                        "appDeviceId": "electron-app",
                    }
                },
            )
        )
        db.commit()
    register_plugin_snapshot_intent(
        snapshot_sessions,
        user_id=1,
        device_id="electron-app",
        payload=_intent(7, [123]),
    )
    register_plugin_snapshot_intent(
        snapshot_sessions,
        user_id=1,
        device_id="runtime-device",
        payload=_intent(8, [456]),
    )

    with snapshot_sessions() as db:
        state = lock_plugin_sync_state(db, 1)
        assert list(state.json["spec"]["devices"]) == ["runtime-device"]
        assert plugin_snapshot_watermark(state, "runtime-device", 123) == 7
        assert plugin_snapshot_watermark(state, "runtime-device", 456) == 8


def test_locking_read_refreshes_cached_state_before_merging_ack(snapshot_sessions):
    with snapshot_sessions() as stale_db:
        cached = lock_plugin_sync_state(stale_db, 1)
        advance_plugin_snapshot_watermark(
            cached, "device", generation=7, complete=False, installed_plugin_ids=[123]
        )
        stale_db.commit()
        register_plugin_snapshot_intent(
            snapshot_sessions,
            user_id=1,
            device_id="device",
            payload=_intent(9, [123]),
        )
        locked = lock_plugin_sync_state(stale_db, 1)
        assert locked is cached
        assert plugin_snapshot_watermark(locked, "device", 123) == 9
        advance_plugin_snapshot_watermark(
            locked, "device", generation=8, complete=False, installed_plugin_ids=[456]
        )
        stale_db.commit()

    with snapshot_sessions() as db:
        state = lock_plugin_sync_state(db, 1)
        assert state.json["spec"]["generation"] == 9
        assert plugin_snapshot_watermark(state, "device", 123) == 9
        assert plugin_snapshot_watermark(state, "device", 456) == 8


def _wire_plugin(db, name):
    plugin = Kind(
        user_id=1,
        kind="InstalledPlugin",
        namespace="default",
        name=name,
        json={
            "spec": {
                "marketplace": "test",
                "version": "1.0.0",
                "packageRef": {"checksum": "sha256:" + "a" * 64},
            }
        },
        is_active=True,
    )
    db.add(plugin)
    db.commit()
    return plugin.id


def _wire_ack(payload):
    metadata = payload.get("plugin_sync")
    items = []
    for field, operation, status in (
        ("plugins", "upsert", "synced"),
        ("removed_plugins", "remove", "removed"),
    ):
        for plugin in payload.get(field) or []:
            item = {"id": plugin["installed_plugin_id"], "status": status}
            if metadata:
                item.update(
                    generation=metadata["generation"],
                    operation=operation,
                    version=plugin.get("version"),
                    checksum=plugin.get("checksum"),
                )
            items.append(item)
    acknowledgement = {
        "success": True,
        "scope": payload.get("scope") or "all",
        "plugins": items,
    }
    if metadata:
        acknowledgement["plugin_sync"] = deepcopy(metadata)
    return acknowledgement


def _wire_route(*, versioned):
    return SimpleNamespace(
        runtime_device_id="runtime-device",
        socket_id="socket-device",
        online_info={
            "runtime_features": (
                {"pluginSync": {"protocolVersion": 2}} if versioned else {}
            )
        },
    )


@pytest.mark.parametrize(
    "error_code",
    [
        "plugin_write_busy",
        "plugin_write_unavailable",
        "plugin_write_lease_lost",
        "plugin_write_conflict",
    ],
)
@pytest.mark.asyncio
async def test_intent_coordination_failure_propagates_before_executor_rpc(
    snapshot_sessions, monkeypatch, error_code
):
    with snapshot_sessions() as db:
        target = _wire_plugin(db, "target")
    failure = PluginWriteError(error_code)
    register = Mock(side_effect=failure)
    call = AsyncMock()
    monkeypatch.setattr(
        "app.services.device.plugin_sync_protocol.register_plugin_snapshot_intent",
        register,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        AsyncMock(return_value=_wire_route(versioned=True)),
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: SimpleNamespace(call=call),
    )

    with pytest.raises(PluginWriteError) as caught:
        await DeviceCapabilitySyncService(snapshot_sessions).sync_plugin_change(
            user_id=1, device_id="device", installed_plugin_ids=[target]
        )

    assert caught.value is failure
    register.assert_called_once()
    call.assert_not_awaited()
    with snapshot_sessions() as db:
        state = db.query(Kind).filter_by(kind="PluginSyncState", user_id=1).one()
        assert plugin_snapshot_watermark(state, "device", target) == 0


@pytest.mark.parametrize("versioned", [False, True])
@pytest.mark.asyncio
async def test_real_dispatch_preserves_old_wire_and_commits_new_intent_before_rpc(
    snapshot_sessions, monkeypatch, versioned
):
    with snapshot_sessions() as db:
        target = _wire_plugin(db, "target")
        other = _wire_plugin(db, "other")
    calls = []

    async def call(event, payload, **kwargs):
        calls.append(deepcopy(payload))
        assert event == "device:sync_capabilities"
        assert kwargs["to"] == "socket-device"
        if versioned:
            with snapshot_sessions() as db:
                state = db.query(Kind).filter_by(kind="PluginSyncState").one()
                assert plugin_snapshot_watermark(state, "device", target) == (
                    payload["plugin_sync"]["generation"]
                )
        return _wire_ack(payload)

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        AsyncMock(return_value=_wire_route(versioned=versioned)),
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: SimpleNamespace(call=call),
    )

    result = await DeviceCapabilitySyncService(snapshot_sessions).sync_plugin_change(
        user_id=1, device_id="device", installed_plugin_ids=[target]
    )

    assert result.success is True
    assert result.acknowledged is True
    assert len(calls) == 1
    assert calls[0]["device_id"] == "runtime-device"
    assert {item["installed_plugin_id"] for item in calls[0]["plugins"]} == (
        {target} if versioned else {target, other}
    )
    if versioned:
        assert calls[0]["scope"] == "plugin_delta"
        assert calls[0]["mode"] == "merge"
        assert calls[0]["plugin_sync"]["complete"] is False
        assert result.desired_plugin_snapshot is not None
        assert "desired_plugin_snapshot" not in result.model_dump()
    else:
        assert calls[0]["mode"] == "replace"
        assert "plugin_sync" not in calls[0]
        assert "removed_plugins" not in calls[0]
        assert "plugin_sync" not in result.model_dump()
        assert result.desired_plugin_snapshot is None


@pytest.mark.parametrize("change", ["update", "uninstall"])
@pytest.mark.asyncio
async def test_real_dispatch_reloads_committed_target_changes_during_rpc(
    snapshot_sessions, monkeypatch, change
):
    with snapshot_sessions() as db:
        target = _wire_plugin(db, "target")
        other = _wire_plugin(db, "other")
    calls = []

    async def call(_event, payload, **_kwargs):
        calls.append(deepcopy(payload))
        if len(calls) == 1:
            with snapshot_sessions() as db:
                installed = db.get(Kind, target)
                if change == "uninstall":
                    installed.is_active = False
                else:
                    installed.json = {
                        "spec": {**installed.json["spec"], "version": "2.0.0"}
                    }
                db.commit()
        return _wire_ack(payload)

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        AsyncMock(return_value=_wire_route(versioned=True)),
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: SimpleNamespace(call=call),
    )

    result = await DeviceCapabilitySyncService(snapshot_sessions).sync_plugin_change(
        user_id=1, device_id="device", installed_plugin_ids=[target]
    )

    assert result.success is True
    assert len(calls) == 2
    assert calls[0]["plugin_sync"]["generation"] < calls[1]["plugin_sync"]["generation"]
    assert calls[0]["plugins"][0]["version"] == "1.0.0"
    if change == "uninstall":
        assert calls[1]["plugins"] == []
        assert calls[1]["removed_plugins"][0]["installed_plugin_id"] == target
    else:
        assert calls[1]["plugins"][0]["version"] == "2.0.0"
    assert all(
        item["installed_plugin_id"] != other
        for payload in calls
        for field in ("plugins", "removed_plugins")
        for item in payload.get(field) or []
    )


@pytest.mark.asyncio
async def test_new_payload_is_not_sent_after_runtime_loses_advertised_capability(
    snapshot_sessions, monkeypatch
):
    with snapshot_sessions() as db:
        target = _wire_plugin(db, "target")
    resolve = AsyncMock(
        side_effect=[_wire_route(versioned=True), _wire_route(versioned=False)]
    )
    call = AsyncMock()
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        resolve,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: SimpleNamespace(call=call),
    )

    result = await DeviceCapabilitySyncService(snapshot_sessions).sync_plugin_change(
        user_id=1, device_id="device", installed_plugin_ids=[target]
    )

    assert result.success is False
    assert result.acknowledged is False
    assert "capability changed" in result.error
    call.assert_not_awaited()
