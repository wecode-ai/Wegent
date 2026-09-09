# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Device CRD identity resolution contracts."""

from app.models.kind import Kind
from app.models.user import User
from app.services.device_service import device_service


def _device(
    db,
    user: User,
    name: str,
    *,
    device_id: str | None = None,
    app_device_id: str | None = None,
) -> Kind:
    device = Kind(
        user_id=user.id,
        kind="Device",
        name=name,
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "deviceType": "app",
                **({"deviceId": device_id} if device_id else {}),
                **({"appDeviceId": app_device_id} if app_device_id else {}),
            }
        },
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def test_get_device_by_device_id_resolves_app_and_runtime_identities(
    test_db, test_user: User
) -> None:
    """A device must be findable by any of its registered identities so queued
    executions and deliveries persisted under the app id still own the device."""

    _device(
        test_db,
        test_user,
        "local-executor",
        device_id="local-executor",
        app_device_id="electron-app-1",
    )

    assert (
        device_service.get_device_by_device_id(
            test_db, test_user.id, "local-executor"
        ).name
        == "local-executor"
    )
    assert (
        device_service.get_device_by_device_id(
            test_db, test_user.id, "electron-app-1"
        ).name
        == "local-executor"
    )
    assert (
        device_service.get_device_by_device_id(test_db, test_user.id, "missing-device")
        is None
    )


def test_get_device_by_device_id_rejects_ambiguous_app_identity(
    test_db, test_user: User
) -> None:
    """Two active devices sharing one app id must not silently match either."""

    _device(test_db, test_user, "device-a", app_device_id="electron-shared")
    _device(test_db, test_user, "device-b", app_device_id="electron-shared")

    assert (
        device_service.get_device_by_device_id(test_db, test_user.id, "electron-shared")
        is None
    )
