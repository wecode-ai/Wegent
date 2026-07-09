# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for preserving custom device aliases across device re-registration."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device_service import device_service


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
    )

    assert updated.json["spec"]["deviceType"] == DeviceType.APP.value
    assert updated.json["spec"]["appDeviceId"] == "app-device"
    assert updated.json["spec"]["isDefault"] is False
