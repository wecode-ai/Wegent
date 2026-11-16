"""Use owned logical device identities for plugin installation state."""

from datetime import datetime

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceType
from app.services.device.identity import device_identity_ids, device_kind_type
from app.services.device.runtime_route import (
    resolve_runtime_route_identity,
    runtime_device_route_id,
)
from app.services.plugin_write_coordination import acquire_plugin_write_lock


def resolve_plugin_runtime_device_id(
    db: Session, *, user_id: int, device_id: str
) -> str | None:
    """Resolve an owned plugin target, including registered cloud socket aliases."""
    device_id = device_id.strip()
    devices = (
        db.query(Kind)
        .filter_by(user_id=user_id, kind="Device", namespace="default", is_active=True)
        .all()
    )
    cloud_matches = [
        device
        for device in devices
        if device_kind_type(device) == DeviceType.CLOUD
        and runtime_device_route_id(device) == device_id
    ]
    if not cloud_matches:
        identity = resolve_runtime_route_identity(
            db, user_id=user_id, submitted_device_id=device_id
        )
        return identity.logical_device_id if identity is not None else None
    matches = {
        device.id for device in devices if device_id in device_identity_ids(device)
    } | {device.id for device in cloud_matches}
    if len(matches) != 1:
        return None
    identity = resolve_runtime_route_identity(
        db, user_id=user_id, submitted_device_id=cloud_matches[0].name
    )
    if (
        identity is None
        or identity.device_type != DeviceType.CLOUD
        or identity.runtime_device_id != device_id
    ):
        return None
    return identity.logical_device_id


def plugin_device_id(db: Session, user_id: int, device_id: str) -> str:
    """Resolve an app or Runtime alias without requiring an online socket."""
    submitted = device_id.strip()
    identity = resolve_runtime_route_identity(
        db, user_id=user_id, submitted_device_id=submitted
    )
    if identity is None:
        return submitted
    # App records have stable routes even when legacy logical names collide.
    return (
        identity.runtime_device_id
        if identity.device_type == DeviceType.APP
        else identity.logical_device_id
    )


def coalesce_plugin_device_rows(
    db: Session, rows: list[PluginDeviceInstallation]
) -> dict[tuple[int, str], PluginDeviceInstallation]:
    """Read legacy aliases as one device using its most recent reported state."""
    identities: dict[tuple[int, str], str] = {}
    selected: dict[tuple[int, str], PluginDeviceInstallation] = {}
    for row in rows:
        identity_key = (row.user_id, row.device_id)
        if identity_key not in identities:
            identities[identity_key] = plugin_device_id(db, *identity_key)
        canonical_id = identities[identity_key]
        key = (row.installed_kind_id, canonical_id)
        previous = selected.get(key)
        if previous is None or _state_order(row, canonical_id) > _state_order(
            previous, canonical_id
        ):
            selected[key] = row
    return selected


def _state_order(row: PluginDeviceInstallation, canonical_id: str) -> tuple:
    return (
        row.last_sync_at or datetime.min,
        row.updated_at or datetime.min,
        row.device_id == canonical_id,
    )


def plugin_device_rows(
    db: Session, user_id: int, device_id: str
) -> dict[int, PluginDeviceInstallation]:
    canonical_id = plugin_device_id(db, user_id, device_id)
    rows = (
        db.query(PluginDeviceInstallation)
        .filter(PluginDeviceInstallation.user_id == user_id)
        .all()
    )
    return {
        installed_id: row
        for (installed_id, row_device_id), row in coalesce_plugin_device_rows(
            db, rows
        ).items()
        if row_device_id == canonical_id
    }


def reconcile_plugin_device_rows(db: Session, user_id: int) -> None:
    """Converge legacy alias rows within the caller's write transaction.

    Keep the last reported state, including failures and retry counts. A fresh
    device acknowledgement, not the account's desired version, confirms success.
    """
    acquire_plugin_write_lock(db, user_id)
    rows = (
        db.query(PluginDeviceInstallation)
        .filter(PluginDeviceInstallation.user_id == user_id)
        .all()
    )
    selected = coalesce_plugin_device_rows(db, rows)
    retained_ids = {row.id for row in selected.values()}
    for row in rows:
        if row.id not in retained_ids:
            db.delete(row)
    # Remove colliding aliases before assigning the unique canonical key.
    db.flush()
    for (_, canonical_id), row in selected.items():
        row.device_id = canonical_id
    db.flush()
