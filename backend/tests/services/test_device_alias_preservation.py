# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for preserving custom device aliases across device re-registration."""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device_service import (
    RuntimeInstanceMismatchError,
    device_service,
)


def test_upsert_device_crd_preserves_existing_custom_alias(test_db: Session, test_user):
    """Re-registering a device should not overwrite a user-defined alias."""
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name="device-123",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {
                "name": "device-123",
                "namespace": "default",
                "displayName": "My Custom Alias",
            },
            "spec": {
                "deviceId": "device-123",
                "displayName": "My Custom Alias",
                "deviceType": DeviceType.LOCAL.value,
                "connectionMode": "websocket",
                "bindShell": "claudecode",
                "isDefault": True,
                "capabilities": ["gpu"],
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(device)
    test_db.commit()

    updated = device_service.upsert_device_crd(
        test_db,
        test_user.id,
        "device-123",
        "Windows-Device-ae399aedc49c",
        client_ip="127.0.0.1",
        device_type=DeviceType.LOCAL.value,
        bind_shell="claudecode",
    )

    assert updated.json["spec"]["displayName"] == "My Custom Alias"
    assert updated.json["metadata"]["displayName"] == "My Custom Alias"
    assert updated.json["spec"]["clientIp"] == "127.0.0.1"
    assert updated.json["spec"]["deviceType"] == DeviceType.LOCAL.value


def test_upsert_device_crd_stores_runtime_instance_id(test_db: Session, test_user):
    """Device registration should persist the stable runtime installation ID."""
    updated = device_service.upsert_device_crd(
        test_db,
        test_user.id,
        "route-device",
        "MacBook Route",
        device_type=DeviceType.LOCAL.value,
        bind_shell="claudecode",
        runtime_instance_id="runtime-stable",
    )

    assert updated.json["spec"]["deviceId"] == "route-device"
    assert updated.json["spec"]["runtimeInstanceId"] == "runtime-stable"


@pytest.mark.parametrize("device_type", [DeviceType.CLOUD, DeviceType.REMOTE])
@pytest.mark.parametrize(
    "replacement_runtime_instance_id",
    ["runtime-replacement", None, ""],
)
def test_upsert_persistent_device_rejects_runtime_instance_change(
    test_db: Session,
    test_user,
    device_type: DeviceType,
    replacement_runtime_instance_id: str | None,
):
    """Persistent devices reject changed or missing Runtime identities."""
    device_id = f"{device_type.value}-persistent-device"
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name=device_id,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": {
                "deviceId": device_id,
                "deviceType": device_type.value,
                "runtimeInstanceId": "runtime-original",
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(device)
    test_db.commit()

    with pytest.raises(
        RuntimeInstanceMismatchError,
        match="Runtime instance ID mismatch",
    ):
        device_service.upsert_device_crd(
            test_db,
            test_user.id,
            device_id,
            "Replacement Runtime",
            device_type=device_type.value,
            runtime_instance_id=replacement_runtime_instance_id,
        )

    test_db.expire_all()
    persisted_devices = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name == device_id,
        )
        .all()
    )
    assert len(persisted_devices) == 1
    assert persisted_devices[0].json["spec"]["runtimeInstanceId"] == "runtime-original"


@pytest.mark.parametrize("device_type", [DeviceType.CLOUD, DeviceType.REMOTE])
def test_upsert_persistent_device_pins_first_runtime_instance(
    test_db: Session,
    test_user,
    device_type: DeviceType,
):
    """An unpinned persistent device may accept its first Runtime instance."""
    device_id = f"{device_type.value}-unpinned-device"
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name=device_id,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": {
                "deviceId": device_id,
                "deviceType": device_type.value,
                "runtimeInstanceId": None,
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(device)
    test_db.commit()

    updated = device_service.upsert_device_crd(
        test_db,
        test_user.id,
        device_id,
        "First Runtime",
        device_type=device_type.value,
        runtime_instance_id="runtime-first",
    )

    assert updated.json["spec"]["runtimeInstanceId"] == "runtime-first"


@pytest.mark.parametrize("device_type", [DeviceType.LOCAL, DeviceType.APP])
def test_upsert_local_and_app_devices_reject_runtime_replacement(
    test_db: Session,
    test_user,
    device_type: DeviceType,
):
    """Desktop registrations cannot take over another Runtime's device ID."""
    device_id = f"{device_type.value}-replaceable-runtime"
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name=device_id,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": {
                "deviceId": device_id,
                "deviceType": device_type.value,
                "runtimeInstanceId": "runtime-before",
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(device)
    test_db.commit()

    with pytest.raises(RuntimeInstanceMismatchError):
        device_service.upsert_device_crd(
            test_db,
            test_user.id,
            device_id,
            "Updated Runtime",
            device_type=device_type.value,
            runtime_instance_id="runtime-after",
            app_device_id="electron-app" if device_type == DeviceType.APP else None,
        )

    test_db.refresh(device)
    assert device.json["spec"]["runtimeInstanceId"] == "runtime-before"


def test_upsert_app_device_uses_app_type_without_becoming_default(
    test_db: Session,
    test_user,
):
    """Desktop app registration should keep its explicit app type."""
    updated = device_service.upsert_device_crd(
        test_db,
        test_user.id,
        "app-device",
        "MacBook App",
        device_type=DeviceType.APP.value,
        bind_shell="claudecode",
        app_device_id="app-device",
        runtime_instance_id="runtime-app",
    )

    assert updated.json["spec"]["deviceType"] == DeviceType.APP.value
    assert updated.json["spec"]["appDeviceId"] == "app-device"
    assert updated.json["spec"]["isDefault"] is False


def test_upsert_restores_legacy_remote_wework_device_as_app_without_duplicate(
    test_db: Session,
    test_user,
):
    device_id = "desktop-runtime-device"
    runtime_instance_id = "runtime-stable"

    legacy_remote_device = device_service.upsert_device_crd(
        test_db,
        test_user.id,
        device_id,
        "MacBook App",
        device_type=DeviceType.REMOTE.value,
        runtime_instance_id=runtime_instance_id,
        app_device_id=device_id,
    )
    restored_app_device = device_service.upsert_device_crd(
        test_db,
        test_user.id,
        device_id,
        "MacBook App",
        device_type=DeviceType.APP.value,
        runtime_instance_id=runtime_instance_id,
        app_device_id=device_id,
    )

    persisted = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name == device_id,
        )
        .all()
    )
    assert legacy_remote_device.id == restored_app_device.id
    assert len(persisted) == 1
    assert persisted[0].json["spec"]["deviceType"] == DeviceType.APP.value
    assert persisted[0].json["spec"]["runtimeInstanceId"] == runtime_instance_id
    assert persisted[0].json["spec"]["appDeviceId"] == device_id
