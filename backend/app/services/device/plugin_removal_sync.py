"""Finish device cleanup from persisted account uninstall state."""

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.device.runtime_route import runtime_device_route_id
from app.services.plugin_device_identity import plugin_device_id
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
RETRY_INTERVAL_SECONDS = 60
MAX_RETRY_INTERVAL_SECONDS = 3600
# Coordination only; pending work remains in PluginDeviceInstallation across restarts.
_inflight: set[tuple[int, str]] = set()


def prepare_plugin_removal(db: Session, user_id: int, installed_id: int) -> None:
    """Stage durable cleanup in the same transaction as the account removal."""
    installed = (
        db.query(Kind)
        .filter_by(
            id=installed_id,
            user_id=user_id,
            kind="InstalledPlugin",
            namespace="default",
        )
        .with_for_update()
        .first()
    )
    if installed is None:
        return
    # Older/uploaded installations may not yet have materialization rows.
    devices = (
        db.query(Kind)
        .filter_by(user_id=user_id, kind="Device", namespace="default", is_active=True)
        .all()
    )
    existing = {
        plugin_device_id(db, user_id, row.device_id)
        for row in db.query(PluginDeviceInstallation)
        .filter_by(user_id=user_id, installed_kind_id=installed_id)
        .all()
    }
    for device in devices:
        target = plugin_device_id(db, user_id, runtime_device_route_id(device))
        if target and target not in existing:
            db.add(
                PluginDeviceInstallation(
                    user_id=user_id,
                    installed_kind_id=installed_id,
                    device_id=target,
                    state="uninstalling",
                )
            )
            existing.add(target)
    plugin_device_installation_service.mark_uninstalling(
        db, user_id=user_id, installed_kind_id=installed_id, commit=False
    )


def pending_removal_devices(user_id: int, device_id: str | None) -> set[str]:
    with get_db_session() as db:
        rows = (
            db.query(PluginDeviceInstallation)
            .join(Kind, Kind.id == PluginDeviceInstallation.installed_kind_id)
            .filter(
                PluginDeviceInstallation.user_id == user_id,
                Kind.user_id == user_id,
                Kind.namespace == "default",
                Kind.kind == "InstalledPlugin",
                Kind.is_active.is_(False),
                or_(
                    PluginDeviceInstallation.state == "uninstalling",
                    PluginDeviceInstallation.last_sync_at
                    < datetime.now() - timedelta(seconds=RETRY_INTERVAL_SECONDS),
                ),
            )
            .all()
        )
        target = plugin_device_id(db, user_id, device_id) if device_id else None
        now = datetime.now()
        devices = {
            plugin_device_id(db, user_id, row.device_id)
            for row in rows
            if removal_retry_due(row, now)
        }
        return devices & {target} if target else devices


def removal_retry_due(row: PluginDeviceInstallation, now: datetime) -> bool:
    """Retry persisted failures with bounded backoff, never an in-memory timer."""
    if row.state == "uninstalling":
        return True
    if row.last_sync_at is None:
        return False
    exponent = min(max((row.attempt_count or 0) - 1, 0), 6)
    interval = min(RETRY_INTERVAL_SECONDS * 2**exponent, MAX_RETRY_INTERVAL_SECONDS)
    return row.last_sync_at <= now - timedelta(seconds=interval)


async def _sync_device(user_id: int, device_id: str) -> None:
    key = (user_id, device_id)
    if key in _inflight:
        return
    _inflight.add(key)
    try:
        # Always rebuild desired state, including a reinstall committed meanwhile.
        result = await device_capability_sync_service.sync_current_device_capabilities(
            user_id=user_id, device_id=device_id
        )
        await asyncio.to_thread(_record_sync_result, user_id, result)
        if not result.success:
            logger.warning(
                "Plugin removal sync pending: user_id=%s device_id=%s",
                user_id,
                device_id,
            )
    except Exception:
        logger.exception(
            "Plugin removal sync failed: user_id=%s device_id=%s", user_id, device_id
        )
    finally:
        _inflight.discard(key)


def _record_sync_result(user_id: int, result: DeviceCapabilitySyncResult) -> None:
    with get_db_session() as db:
        plugin_device_installation_service.record_device_sync_result(
            db, user_id=user_id, result=result
        )


@trace_async(tracer_name="backend.plugins", span_name="sync_pending_plugin_removals")
async def sync_pending_plugin_removals(
    user_id: int, device_id: str | None = None
) -> None:
    """Drain persisted removals after DELETE or a device heartbeat.

    A lost background task leaves the rows intact. Heartbeats and registration
    replay the authoritative desired state, without a second queue or snapshot.
    """
    targets = await asyncio.to_thread(pending_removal_devices, user_id, device_id)
    await asyncio.gather(*(_sync_device(user_id, target) for target in targets))
