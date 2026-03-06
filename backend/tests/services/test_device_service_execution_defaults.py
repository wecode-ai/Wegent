# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for device defaults grouped by device type."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device_service import device_service


def _create_device(
    db: Session,
    owner_user_id: int,
    device_id: str,
    device_type: DeviceType,
    *,
    is_default: bool = False,
) -> Kind:
    device = Kind(
        user_id=owner_user_id,
        kind="Device",
        name=device_id,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": {
                "deviceId": device_id,
                "displayName": device_id,
                "deviceType": device_type.value,
                "connectionMode": "websocket",
                "isDefault": is_default,
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def test_set_device_as_default_only_clears_same_device_type(
    test_db: Session, test_user
):
    """Setting a default should only affect devices of the same type."""
    local_a = _create_device(
        test_db, test_user.id, "local-a", DeviceType.LOCAL, is_default=True
    )
    local_b = _create_device(test_db, test_user.id, "local-b", DeviceType.LOCAL)
    cloud_a = _create_device(
        test_db, test_user.id, "cloud-a", DeviceType.CLOUD, is_default=True
    )

    success = device_service.set_device_as_default(test_db, test_user.id, local_b.name)

    assert success is True

    refreshed_local_a = test_db.query(Kind).filter(Kind.id == local_a.id).first()
    refreshed_local_b = test_db.query(Kind).filter(Kind.id == local_b.id).first()
    refreshed_cloud_a = test_db.query(Kind).filter(Kind.id == cloud_a.id).first()

    assert refreshed_local_a.json["spec"]["isDefault"] is False
    assert refreshed_local_b.json["spec"]["isDefault"] is True
    assert refreshed_cloud_a.json["spec"]["isDefault"] is True


def test_get_default_device_for_type_falls_back_to_single_matching_device(
    test_db: Session, test_user
):
    """A single device of a type should be returned even without an explicit default."""
    device = _create_device(
        test_db, test_user.id, "cloud-only", DeviceType.CLOUD, is_default=False
    )

    resolved = device_service.get_default_device_for_type(
        test_db, test_user.id, DeviceType.CLOUD
    )

    assert resolved is not None
    assert resolved.id == device.id
