# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Identity checks shared by registration, status, and device operations."""

from typing import Any

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User


class DeviceIdentityConflictError(ValueError):
    """An identity cannot safely identify one owned device."""


class RuntimeInstanceMismatchError(DeviceIdentityConflictError):
    """A device attempted to replace another installation's Runtime."""


RECORD_ROUTE_PREFIX = "app-record-"


def record_route_id(device: Kind) -> str:
    """Keep transport identity independent of legacy duplicate logical names."""
    if device.json.get("spec", {}).get("deviceType") == "app":
        return f"{RECORD_ROUTE_PREFIX}{device.id}"
    return device.name


def record_id_from_route(device_id: str) -> int | None:
    if device_id.startswith(RECORD_ROUTE_PREFIX):
        suffix = device_id.removeprefix(RECORD_ROUTE_PREFIX)
        if suffix.isascii() and suffix.isdecimal() and int(suffix) > 0:
            return int(suffix)
    return None


def lock_device_owner(db: Session, user_id: int) -> None:
    """Serialize registration and deletion without a new schema constraint."""
    if db.get_bind().dialect.name == "sqlite":
        # SQLite ignores FOR UPDATE; a write reserves its database write lock.
        db.execute(update(User).where(User.id == user_id).values(id=User.id))
    else:
        db.query(User.id).filter(User.id == user_id).with_for_update().first()


def validate_persistent_runtime_instance_id(
    device_json: dict[str, Any],
    runtime_instance_id: str | None,
    *,
    device_id: str,
) -> None:
    """Pin every registered device type to its first Runtime installation."""
    spec = device_json.get("spec", {})
    persisted = spec.get("runtimeInstanceId")
    if persisted and persisted != runtime_instance_id:
        raise RuntimeInstanceMismatchError(
            "Runtime instance ID mismatch for persistent "
            f"{spec.get('deviceType', 'local')} device {device_id}"
        )


def find_registration_device(
    db: Session,
    user_id: int,
    device_id: str,
    runtime_instance_id: str | None,
    app_device_id: str | None = None,
) -> Kind | None:
    """Serialize first registration on the owner, then lock the scoped identity."""
    if device_id.startswith(RECORD_ROUTE_PREFIX):
        raise DeviceIdentityConflictError("Device ID uses a reserved routing prefix")
    lock_device_owner(db, user_id)
    devices = (
        db.query(Kind)
        .filter_by(user_id=user_id, kind="Device", namespace="default", name=device_id)
        .with_for_update()
        .order_by(Kind.id)
        .all()
    )
    exact = [
        device
        for device in devices
        if runtime_instance_id
        and device.json.get("spec", {}).get("runtimeInstanceId") == runtime_instance_id
        and device.json.get("spec", {}).get("appDeviceId") == app_device_id
    ]
    if exact:
        # Reuse a stable record, including a previously removed installation.
        return next((device for device in exact if device.is_active), exact[0])
    active = [device for device in devices if device.is_active]
    if len(active) > 1:
        raise DeviceIdentityConflictError(
            f"Ambiguous device identity {device_id}; select or reconnect the original installation"
        )
    if active:
        return active[0]
    if len(devices) > 1:
        devices = [
            device
            for device in devices
            if device.json.get("spec", {}).get("runtimeInstanceId")
            == runtime_instance_id
        ]
        if len(devices) != 1:
            raise DeviceIdentityConflictError(
                f"Ambiguous inactive device identity {device_id}; reconnect using the original installation identity"
            )
    return devices[0] if devices else None


def owned_active_device(db: Session, user_id: int, device_id: str) -> Kind | None:
    """Never silently select a legacy duplicate for a destructive operation."""
    query = db.query(Kind).filter_by(
        user_id=user_id,
        kind="Device",
        namespace="default",
        is_active=True,
    )
    record_id = record_id_from_route(device_id)
    if record_id is not None:
        device = query.filter_by(id=record_id).one_or_none()
        return (
            device
            if device and device.json.get("spec", {}).get("deviceType") == "app"
            else None
        )
    devices = query.filter_by(name=device_id).limit(2).all()
    if len(devices) > 1:
        raise DeviceIdentityConflictError(
            f"Duplicate active device identity {device_id}; select a device record explicitly"
        )
    return devices[0] if devices else None


def matching_online_info(
    spec: dict[str, Any], online_info: dict[str, Any] | None
) -> dict[str, Any] | None:
    """A shared Redis key is not proof that this database Runtime is online."""
    if not online_info:
        return None
    persisted = spec.get("runtimeInstanceId")
    observed = online_info.get("runtime_instance_id")
    if spec.get("deviceType") == "app" and not persisted:
        return None
    if persisted != observed and (persisted or spec.get("deviceType") == "app"):
        return None
    return online_info
