# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Registration identity and schema-independent serialization regressions."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.device.identity import DeviceIdentityConflictError
from app.services.device.local_provider import AppDeviceProvider
from app.services.device_service import device_service


def register(db, user_id=7, **kwargs):
    return device_service.upsert_device_crd(
        db,
        user_id,
        "app-route",
        "My Wework",
        device_type="app",
        runtime_instance_id="runtime-app",
        app_device_id="electron-app",
        **kwargs,
    )


def test_registration_rejects_reserved_record_route(test_db):
    with pytest.raises(DeviceIdentityConflictError, match="reserved routing prefix"):
        device_service.upsert_device_crd(test_db, 7, "app-record-123", "Invalid")


def test_repeated_registration_preserves_record_and_inactive_history(test_db):
    stale = Kind(
        user_id=7,
        kind="Device",
        name="app-route",
        namespace="default",
        is_active=False,
        json={"spec": {"runtimeInstanceId": "runtime-old"}},
    )
    active = Kind(
        user_id=7,
        kind="Device",
        name="app-route",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "runtimeInstanceId": "runtime-app",
                "appDeviceId": "electron-app",
                "deviceType": "app",
            }
        },
    )
    test_db.add_all([stale, active])
    test_db.commit()
    original_id = active.id
    assert register(test_db).id == original_id
    assert register(test_db).id == original_id
    test_db.refresh(stale)
    assert stale.is_active is False


def test_new_app_identity_creates_independent_record(test_db):
    original = register(test_db)
    replacement = device_service.upsert_device_crd(
        test_db,
        7,
        original.name,
        "Other Wework",
        device_type="app",
        runtime_instance_id="runtime-app",
        app_device_id="electron-other",
    )

    test_db.refresh(original)
    assert replacement.id != original.id
    assert original.json["spec"]["appDeviceId"] == "electron-app"
    assert replacement.json["spec"]["appDeviceId"] == "electron-other"
    assert original.is_active is True
    assert replacement.is_active is True


def test_new_app_identity_does_not_reactivate_removed_record(test_db):
    removed = register(test_db)
    removed.is_active = False
    test_db.commit()

    replacement = device_service.upsert_device_crd(
        test_db,
        7,
        removed.name,
        "Replacement Wework",
        device_type="app",
        runtime_instance_id="runtime-app",
        app_device_id="electron-replacement",
    )

    test_db.refresh(removed)
    assert replacement.id != removed.id
    assert removed.is_active is False
    assert replacement.is_active is True


def test_same_app_identity_reactivates_removed_record(test_db):
    removed = register(test_db)
    removed.is_active = False
    test_db.commit()

    restored = register(test_db)

    assert restored.id == removed.id
    assert restored.is_active is True


@pytest.mark.parametrize("runtime_id,app_id", [(None, "app"), ("", None), (" ", "app")])
def test_app_registration_requires_persistent_runtime_identity(
    test_db, runtime_id, app_id
):
    with pytest.raises(DeviceIdentityConflictError, match="requires a persistent"):
        device_service.upsert_device_crd(
            test_db,
            7,
            "new-app",
            "Wework",
            device_type="app",
            runtime_instance_id=runtime_id,
            app_device_id=app_id,
        )
    assert test_db.query(Kind).filter_by(name="new-app").count() == 0


def test_app_without_ipc_exposure_does_not_invent_app_device_id(test_db):
    device = device_service.upsert_device_crd(
        test_db,
        7,
        "standalone-app",
        "App",
        device_type="app",
        runtime_instance_id="runtime-standalone",
    )
    assert device.json["spec"]["appDeviceId"] is None


async def test_provider_registration_uses_same_identity_guard(test_db):
    from unittest.mock import AsyncMock, patch

    device = register(test_db)
    provider = AppDeviceProvider()
    with patch.object(provider, "_set_online", AsyncMock()) as online:
        other = await provider.register(
            test_db,
            7,
            device.name,
            "Other Wework",
            socket_id="other-socket",
            runtime_instance_id="runtime-other",
            app_device_id="electron-other",
        )
        result = await provider.register(
            test_db,
            7,
            device.name,
            "My Wework",
            socket_id="valid-socket",
            runtime_instance_id="runtime-app",
            app_device_id="electron-app",
            capabilities=["coding"],
        )
        assert other["id"] != device.id
        assert result == {"id": device.id, "is_default": False}
        assert online.await_count == 2
        assert (
            online.await_args_list[0].kwargs["runtime_instance_id"] == "runtime-other"
        )
        assert online.await_args_list[1].kwargs["runtime_instance_id"] == "runtime-app"
    test_db.refresh(device)
    assert device.json["spec"]["capabilities"] == ["coding"]


@pytest.mark.parametrize("different_runtimes", [False, True])
def test_concurrent_first_registration_is_idempotent(tmp_path, different_runtimes):
    engine = create_engine(f"sqlite:///{tmp_path / 'registrations.sqlite3'}")
    User.__table__.create(engine)
    Kind.__table__.create(engine)
    barrier = Barrier(4)

    def connect(index):
        with Session(engine) as db:
            barrier.wait(timeout=10)
            runtime_id = f"runtime-{index}" if different_runtimes else "runtime-app"
            device = device_service.upsert_device_crd(
                db,
                7,
                "app-route",
                "Wework",
                device_type="app",
                runtime_instance_id=runtime_id,
                app_device_id="electron-app",
            )
            return device.id

    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(connect, range(4)))
        expected_records = 4 if different_runtimes else 1
        assert len(set(ids)) == expected_records
        with Session(engine) as db:
            assert (
                db.query(Kind).filter_by(kind="Device", is_active=True).count()
                == expected_records
            )
    finally:
        engine.dispose()


def test_existing_schema_accepts_legacy_duplicates_without_migration(test_db):
    register(test_db)
    for values in [
        {"user_id": 8},
        {"namespace": "other"},
        {"is_active": False},
        {"kind": "Team"},
        {"kind": "Team"},
    ]:
        fields = dict(user_id=7, namespace="default", kind="Device", is_active=True)
        fields.update(values)
        test_db.add(Kind(name="app-route", json={}, **fields))
    test_db.commit()
    test_db.add(
        Kind(user_id=7, namespace="default", kind="Device", name="app-route", json={})
    )
    test_db.commit()
    assert "active_device_name" not in Kind.__table__.columns


def test_registration_selects_exact_legacy_installation_and_preserves_others(test_db):
    first = register(test_db)
    other = Kind(
        user_id=7,
        namespace="default",
        kind="Device",
        name="app-route",
        json={
            "spec": {
                "deviceType": "app",
                "deviceId": "app-route",
                "runtimeInstanceId": "runtime-other",
                "appDeviceId": "electron-other",
            }
        },
    )
    duplicate = Kind(
        user_id=7, namespace="default", kind="Device", name="app-route", json=first.json
    )
    test_db.add_all([other, duplicate])
    test_db.commit()
    assert register(test_db).id == first.id
    assert (
        device_service.upsert_device_crd(
            test_db,
            7,
            "app-route",
            "Second",
            device_type="app",
            runtime_instance_id="runtime-other",
            app_device_id="electron-other",
        ).id
        == other.id
    )
    test_db.refresh(duplicate)
    assert duplicate.is_active is True
    unknown = device_service.upsert_device_crd(
        test_db,
        7,
        "app-route",
        "Unknown",
        device_type="app",
        runtime_instance_id="runtime-unknown",
        app_device_id="electron-unknown",
    )
    assert unknown.id not in {first.id, other.id, duplicate.id}
