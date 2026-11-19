"""Finish device cleanup from persisted account uninstall state."""

import asyncio
import logging
from datetime import datetime, timedelta
from functools import partial
from weakref import WeakValueDictionary

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.device.plugin_sync_io import limit_plugin_sync_io, run_plugin_sync_db
from app.services.device.plugin_sync_protocol import supports_plugin_sync_v2
from app.services.device.runtime_route import (
    RuntimeRouteError,
    runtime_device_route_id,
    runtime_route_resolver,
)
from app.services.plugin_device_identity import plugin_device_id
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_kind_revision import kind_revision
from app.services.plugin_write_coordination import (
    OPERATION_SECONDS,
    acquire_plugin_write_lock,
)
from app.services.plugin_write_errors import PluginWriteError
from app.services.plugin_write_operations import run_plugin_transaction
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
RETRY_INTERVAL_SECONDS = 60
MAX_RETRY_INTERVAL_SECONDS = 3600
# Coordination only; pending work remains in PluginDeviceInstallation across restarts.
_inflight: set[tuple[int, str]] = set()
_wakeups: set[tuple[int, str]] = set()
_removal_db_slots = asyncio.Semaphore(2)
_device_slots: WeakValueDictionary[int, asyncio.Semaphore] = WeakValueDictionary()


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
        .first()
    )
    if installed is None:
        return
    acquire_plugin_write_lock(db, user_id, installed_id=installed_id)
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
        selected = devices & {target} if target else devices
        logger.info(
            "Plugin removal scan user_id=%s submitted_device_id=%s "
            "canonical_target=%s eligible_devices=%s selected_devices=%s rows=%s",
            user_id,
            device_id,
            target,
            sorted(devices),
            sorted(selected),
            [
                {
                    "installed_id": row.installed_kind_id,
                    "device_id": row.device_id,
                    "state": row.state,
                    "attempt_count": row.attempt_count,
                    "last_sync_at": row.last_sync_at,
                    "retry_due": removal_retry_due(row, now),
                }
                for row in rows
            ],
        )
        return selected


def removal_retry_due(row: PluginDeviceInstallation, now: datetime) -> bool:
    """Retry persisted failures with bounded backoff, never an in-memory timer."""
    if row.state == "uninstalling":
        return True
    if row.last_sync_at is None:
        return False
    exponent = min(max((row.attempt_count or 0) - 1, 0), 6)
    interval = min(RETRY_INTERVAL_SECONDS * 2**exponent, MAX_RETRY_INTERVAL_SECONDS)
    return row.last_sync_at <= now - timedelta(seconds=interval)


@trace_async(tracer_name="backend.plugins", span_name="drain_device_plugin_removals")
async def _sync_device(user_id: int, device_id: str) -> None:
    key = (user_id, device_id)
    if key in _inflight:
        _wakeups.add(key)
        logger.info(
            "Plugin removal wakeup merged reason=inflight user_id=%s device_id=%s",
            user_id,
            device_id,
        )
        return
    _inflight.add(key)
    try:
        while True:
            _wakeups.discard(key)
            await _sync_device_once(user_id, device_id)
            # Consume real concurrent notifications, rechecking durable work and
            # backoff before another attempt. A notification arriving during
            # the query must also be consumed before releasing the drainer.
            while key in _wakeups:
                _wakeups.discard(key)
                pending = await run_plugin_sync_db(
                    pending_removal_devices, user_id, device_id
                )
                if device_id in pending:
                    break
            else:
                return
    finally:
        _wakeups.discard(key)
        _inflight.discard(key)


async def _sync_device_once(user_id: int, device_id: str) -> None:
    try:
        route = await runtime_route_resolver.resolve(
            user_id=user_id, submitted_device_id=device_id
        )
        removals = await run_plugin_sync_db(_pending_removals, user_id, device_id)
        if not removals:
            return
        if supports_plugin_sync_v2(route.online_info.get("runtime_features")):
            result = await device_capability_sync_service.sync_plugin_change(
                user_id=user_id,
                device_id=device_id,
                installed_plugin_ids=list(removals),
                versioned=True,
            )
            revisions = removals
        else:
            result = (
                await device_capability_sync_service.sync_current_device_capabilities(
                    user_id=user_id,
                    device_id=device_id,
                    versioned=False,
                    capture_plugin_revisions=partial(
                        _legacy_receipt_revisions, user_id=user_id, device_id=device_id
                    ),
                )
            )
            revisions = {
                **removals,
                **(result.desired_plugin_snapshot or {}).get("_receipt_revisions", {}),
            }
        if not result.acknowledged:
            return
        recorded = await _record_sync_result(user_id, result, revisions)
        logger.info(
            "Plugin removal result %s user_id=%s device_id=%s "
            "success=%s acknowledged=%s",
            "recorded" if recorded else "pending",
            user_id,
            device_id,
            result.success,
            result.acknowledged,
        )
        if not result.success:
            logger.warning(
                "Plugin removal sync pending: user_id=%s device_id=%s",
                user_id,
                device_id,
            )
    except RuntimeRouteError as error:
        # No receipt exists. Keep the persisted removal for the next valid route.
        logger.info(
            "Plugin removal deferred user_id=%s device_id=%s reason=%s",
            user_id,
            device_id,
            error.code,
        )
    except Exception:
        logger.exception(
            "Plugin removal sync failed: user_id=%s device_id=%s", user_id, device_id
        )


def _pending_removals(user_id: int, device_id: str) -> dict[int, int]:
    with get_db_session() as db:
        canonical_id = plugin_device_id(db, user_id, device_id)
        now = datetime.now()
        return {
            row.installed_kind_id: kind_revision(installed)
            for row, installed in db.query(PluginDeviceInstallation, Kind)
            .join(Kind, Kind.id == PluginDeviceInstallation.installed_kind_id)
            .filter(
                PluginDeviceInstallation.user_id == user_id,
                PluginDeviceInstallation.device_id == canonical_id,
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.is_active.is_(False),
            )
            .all()
            if removal_retry_due(row, now)
        }


def _legacy_receipt_revisions(
    db: Session, *, user_id: int, device_id: str
) -> dict[int, int]:
    """Fence recording against the specific full snapshot sent to a legacy device."""
    canonical_id = plugin_device_id(db, user_id, device_id)
    tracked = select(PluginDeviceInstallation.installed_kind_id).filter_by(
        user_id=user_id, device_id=canonical_id
    )
    return {
        installed.id: kind_revision(installed)
        for installed in db.query(Kind)
        .filter_by(user_id=user_id, kind="InstalledPlugin", namespace="default")
        .filter(or_(Kind.is_active, Kind.id.in_(tracked)))
    }


async def _record_sync_result(
    user_id: int, result: DeviceCapabilitySyncResult, revisions: dict[int, int]
) -> bool:
    """Retry the acknowledged writes independently of device dispatch."""
    snapshot = result.desired_plugin_snapshot or {}
    desired = {item["installed_plugin_id"] for item in snapshot.get("plugins", [])}
    pending = dict(sorted(revisions.items()))
    loop = asyncio.get_running_loop()
    deadline = loop.time() + OPERATION_SECONDS
    delay = 0.05
    while pending:
        for installed_id, revision in tuple(pending.items()):
            try:
                await run_plugin_sync_db(
                    run_plugin_transaction,
                    partial(
                        plugin_device_installation_service.record_scoped_device_result,
                        user_id=user_id,
                        result=result,
                        installed_id=installed_id,
                        revision=revision,
                        desired=installed_id in desired,
                    ),
                    get_db_session,
                    attempts=1,
                )
            except PluginWriteError as error:
                if error.code not in {
                    "plugin_write_busy",
                    "plugin_write_conflict",
                    "plugin_write_lease_lost",
                }:
                    raise
            else:
                pending.pop(installed_id)
        if not pending:
            return True
        if loop.time() + delay >= deadline:
            break
        # Every attempt has closed its session and released the database slot.
        await asyncio.sleep(delay)
        delay = min(0.25, delay * 2)
    if pending:
        logger.warning(
            "Plugin removal receipt retry exhausted user_id=%s device_id=%s installed_ids=%s",
            user_id,
            result.device_id,
            list(pending),
        )
    return not pending


@trace_async(tracer_name="backend.plugins", span_name="sync_pending_plugin_removals")
async def sync_pending_plugin_removals(
    user_id: int, device_id: str | None = None, *, exclude_device_id: str | None = None
) -> None:
    """Drain persisted removals after DELETE or a device heartbeat.

    A lost background task leaves the rows intact. Heartbeats and registration
    replay the authoritative desired state, without a second queue or snapshot.
    """
    device_slots = _device_slots.get(user_id)
    if device_slots is None:
        device_slots = asyncio.Semaphore(4)
        _device_slots[user_id] = device_slots
    with limit_plugin_sync_io(_removal_db_slots, device_slots):
        targets = await run_plugin_sync_db(pending_removal_devices, user_id, device_id)
        await asyncio.gather(
            *(
                _sync_device(user_id, target)
                for target in targets
                if target != exclude_device_id
            )
        )
