"""Drain durable account changes without coupling them to local completion."""

import asyncio
import logging
import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.models.kind import Kind
from app.models.plugin_local_sync import PluginLocalSyncOperation, PluginSyncOutbox
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.device.plugin_removal_sync import prepare_plugin_removal
from app.services.device_service import device_service
from app.services.plugin_device_identity import plugin_device_id
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_write_coordination import (
    acquire_plugin_write_lock,
    configure_plugin_session,
)
from app.services.plugin_write_operations import run_plugin_operation
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


def claim_event() -> tuple[int, int, int, str, str] | None:
    """Claim one event; no database transaction spans a network operation."""
    with get_db_session() as db:
        now = datetime.utcnow()
        row = (
            db.query(PluginSyncOutbox)
            .filter(
                PluginSyncOutbox.state != "done",
                PluginSyncOutbox.next_attempt_at <= now,
                or_(
                    PluginSyncOutbox.state == "pending",
                    PluginSyncOutbox.lease_until < now,
                ),
            )
            .order_by(PluginSyncOutbox.id)
            .with_for_update(skip_locked=True)
            .first()
        )
        if row is None:
            return None
        row.state = "running"
        row.claim_token = uuid.uuid4().hex
        row.lease_until = now + timedelta(minutes=10)
        row.attempt_count += 1
        row.updated_at = now
        intent = (
            db.query(PluginLocalSyncOperation)
            .filter_by(
                user_id=row.user_id,
                instance_id=row.instance_id,
                operation_id=row.operation_id,
            )
            .one_or_none()
        )
        source = str((intent.document if intent else {}).get("sourceDeviceId") or "")
        if row.instance_id.startswith("auto-update:"):
            source = row.instance_id.removeprefix("auto-update:")
        claim = (row.id, row.user_id, row.installed_id, row.claim_token, source)
        db.commit()
        return claim


def finish_event(event_id: int, token: str, success: bool) -> None:
    with get_db_session() as db:
        row = (
            db.query(PluginSyncOutbox)
            .filter_by(id=event_id, claim_token=token, state="running")
            .with_for_update()
            .one_or_none()
        )
        if row is None:
            return
        row.state = "done" if success else "pending"
        row.updated_at = datetime.utcnow()
        row.next_attempt_at = row.updated_at + timedelta(
            seconds=min(3600, 30 * 2 ** min(row.attempt_count, 7))
        )
        db.commit()


def prepare_targets(db: Session, *, user_id: int, installed_id: int) -> int | None:
    configure_plugin_session(db)
    acquire_plugin_write_lock(db, user_id)
    row = (
        db.query(Kind)
        .filter_by(
            id=installed_id,
            user_id=user_id,
            kind="InstalledPlugin",
            namespace="default",
        )
        .one_or_none()
    )
    if row is None:
        return None
    if not row.is_active:
        prepare_plugin_removal(db, user_id, installed_id)
        db.commit()
    elif isinstance(row.json.get("spec", {}).get("releaseId"), int):
        return row.json["spec"]["releaseId"]
    return None


@trace_async("plugins.outbox.dispatch", "backend.plugins")
async def dispatch_event(user_id: int, installed_id: int, source: str = "") -> bool:
    release = await run_plugin_operation(
        prepare_targets, user_id=user_id, installed_id=installed_id
    )
    if release is not None:
        with get_db_session() as db:
            await plugin_device_installation_service.ensure_pending_for_all_devices(
                db,
                user_id=user_id,
                installed_kind_id=installed_id,
                desired_release_id=release,
                reset_failures=False,
                exclude_device_id=source or None,
            )
    with get_db_session() as db:
        devices = await device_service.get_online_devices(db, user_id)
        excluded = plugin_device_id(db, user_id, source) if source else None
        targets = {
            target
            for device in devices
            if (target := device_capability_sync_service._extract_device_id(device))
            and plugin_device_id(db, user_id, target) != excluded
        }
    semaphore = asyncio.Semaphore(4)

    async def dispatch(target: str) -> bool:
        async with semaphore:
            # This method selects the target's negotiated legacy/v2 protocol,
            # rebuilds current intent, and fences obsolete acknowledgements.
            result = await device_capability_sync_service.sync_plugin_change(
                user_id=user_id,
                device_id=target,
                installed_plugin_ids=[installed_id],
            )
            await run_plugin_operation(
                plugin_device_installation_service.record_device_sync_result,
                user_id=user_id,
                result=result,
            )
            return result.success

    results = await asyncio.gather(
        *(dispatch(target) for target in targets if target), return_exceptions=True
    )
    return all(result is True for result in results)


def cleanup_completed() -> None:
    """Retain all in-flight records; remove only archived-age terminal work."""
    cutoff = datetime.utcnow() - timedelta(days=30)
    with get_db_session() as db:
        db.query(PluginLocalSyncOperation).filter(
            PluginLocalSyncOperation.action == "snapshot",
            PluginLocalSyncOperation.document["state"].as_string() == "issued",
            PluginLocalSyncOperation.created_at < datetime.utcnow() - timedelta(days=1),
        ).update(
            {
                PluginLocalSyncOperation.document: func.json_set(
                    PluginLocalSyncOperation.document, "$.state", "expired"
                ),
                PluginLocalSyncOperation.updated_at: datetime.utcnow(),
            },
            synchronize_session=False,
        )
        db.query(PluginSyncOutbox).filter(
            PluginSyncOutbox.state == "done",
            PluginSyncOutbox.updated_at < cutoff,
        ).delete(synchronize_session=False)
        db.query(PluginLocalSyncOperation).filter(
            PluginLocalSyncOperation.document["state"]
            .as_string()
            .in_(["local_completed", "failed", "superseded", "reconciled", "expired"]),
            PluginLocalSyncOperation.updated_at < cutoff,
        ).delete(synchronize_session=False)
        db.commit()


async def plugin_outbox_worker(stop_event: asyncio.Event) -> None:
    last_cleanup = 0.0
    # Separate from acceptance: keep this enabled while draining during rollback.
    while not stop_event.is_set():
        claim = None
        try:
            if time.monotonic() - last_cleanup >= 3600:
                await asyncio.to_thread(cleanup_completed)
                last_cleanup = time.monotonic()
            claim = await asyncio.to_thread(claim_event)
            if claim:
                event_id, user_id, installed_id, token, source = claim
                success = await asyncio.wait_for(
                    dispatch_event(user_id, installed_id, source), timeout=480
                )
                await asyncio.to_thread(finish_event, event_id, token, success)
                continue
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Plugin outbox dispatch deferred")
            if claim:
                await asyncio.to_thread(finish_event, claim[0], claim[3], False)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=15)
        except asyncio.TimeoutError:
            pass
