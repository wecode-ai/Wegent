"""Synchronize devices after an authoritative account plugin transaction."""

import logging
from functools import partial

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.models.kind import Kind
from app.schemas.device import DeviceCapabilitySyncResponse
from app.schemas.installed_plugin import InstalledPlugin
from app.services.device.capability_sync_service import (
    DESIRED_STATE_SYNC_ATTEMPTS,
    DeviceCapabilityResolutionError,
    DeviceCapabilitySyncError,
    device_capability_sync_service,
)
from app.services.device.plugin_change_sync import schedule_other_devices
from app.services.device.plugin_removal_sync import (
    prepare_plugin_removal,
    sync_pending_plugin_removals,
)
from app.services.device.plugin_sync_protocol import (
    lock_plugin_sync_state,
    plugin_snapshot_watermark,
)
from app.services.device.runtime_route import resolve_runtime_route_identity
from app.services.device_service import device_service
from app.services.plugin_device_identity import (
    plugin_device_id,
    plugin_device_rows,
    resolve_plugin_runtime_device_id,
)
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_write_coordination import (
    acquire_plugin_write_lock,
    configure_plugin_session,
)
from app.services.plugin_write_errors import PluginWriteError
from app.services.plugin_write_operations import run_plugin_operation
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


def _prepare_cloud_sync_after_local_change(
    db: Session, *, user_id: int, installed_id: int
) -> tuple[bool, int | None]:
    configure_plugin_session(db)
    acquire_plugin_write_lock(db, user_id, installed_id=installed_id)
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
        return False, None
    if not row.is_active:
        prepare_plugin_removal(db, user_id, installed_id)
        db.commit()
        return False, None
    release_id = row.json.get("spec", {}).get("releaseId")
    return True, release_id if type(release_id) is int else None


@trace_async(
    span_name="plugins.sync_cloud_after_local_change", tracer_name="backend.plugins"
)
async def sync_cloud_plugins_after_local_change(
    user_id: int, installed_id: int, source_device_id: str | None = None
) -> None:
    """Reuse legacy device synchronization after the local intent has committed."""
    try:
        active, release = await run_plugin_operation(
            _prepare_cloud_sync_after_local_change,
            user_id=user_id,
            installed_id=installed_id,
        )
        if not active:
            await sync_pending_plugin_removals(user_id)
            return
        with get_db_session() as db:
            source = (
                resolve_plugin_runtime_device_id(
                    db, user_id=user_id, device_id=source_device_id
                )
                if source_device_id
                else None
            )
            if release is not None:
                await plugin_device_installation_service.ensure_pending_for_all_devices(
                    db,
                    user_id=user_id,
                    installed_kind_id=installed_id,
                    desired_release_id=release,
                    exclude_device_id=source,
                )
        await sync_plugin_to_other_devices_after_change(user_id, installed_id, source)
    except Exception:
        logger.exception(
            "Cloud plugin sync deferred after local intent: user_id=%s installed_id=%s",
            user_id,
            installed_id,
        )


def deferred_plugin_sync(
    error: PluginWriteError,
    *,
    user_id: int,
    stage: str,
    previous: DeviceCapabilitySyncResponse | None = None,
    device_id: str | None = None,
) -> DeviceCapabilitySyncResponse:
    """Report auxiliary persistence failure without undoing account success."""
    logger.warning(
        "Plugin device sync deferred after account commit: "
        "user_id=%s device_id=%s stage=%s code=%s",
        user_id,
        device_id,
        stage,
        error.code,
    )
    result = previous or DeviceCapabilitySyncResponse(device_id=device_id or "")
    return result.model_copy(
        update={
            "success": False,
            "failed": max(1, result.failed),
            "errors": [*result.errors, {"code": error.code, "stage": stage}],
        }
    )


@trace_async(span_name="plugins.sync_after_commit", tracer_name="backend.plugins")
async def sync_plugin_after_change(
    db: Session,
    *,
    user_id: int,
    installed: InstalledPlugin,
    device_id: str | None,
    reset_failures: bool = False,
    sync_current_device_only: bool = False,
    require_device_success: bool = False,
    runtime_state_changed: bool = False,
) -> DeviceCapabilitySyncResponse | None:
    installed_id = int(installed.metadata["labels"]["id"])
    if require_device_success and device_id is not None:
        try:
            result = (
                await device_capability_sync_service.sync_installed_plugin_to_device(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                    installed_plugin_id=installed_id,
                )
            )
        except DeviceCapabilityResolutionError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except DeviceCapabilitySyncError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
            ) from exc
        except PluginWriteError as exc:
            return deferred_plugin_sync(
                exc, user_id=user_id, device_id=device_id, stage="snapshot"
            )
        finally:
            db.close()
        return await record_sync_response(
            result,
            user_id=user_id,
            device_id=device_id,
            stage="plugin_ack",
            installed_kind_id=installed_id,
        )
    if installed.spec.releaseId is not None:
        try:
            await plugin_device_installation_service.ensure_pending_for_all_devices(
                db,
                user_id=user_id,
                installed_kind_id=installed_id,
                desired_release_id=installed.spec.releaseId,
                reset_failures=reset_failures,
            )
        except PluginWriteError as exc:
            return deferred_plugin_sync(
                exc, user_id=user_id, device_id=device_id, stage="prepare"
            )
        finally:
            db.close()
    if sync_current_device_only:
        if runtime_state_changed:
            return await sync_installed_plugin_on_device(
                db,
                user_id=user_id,
                device_id=device_id,
                installed_id=installed_id,
            )
        return await ensure_installed_plugin_on_device(
            db,
            user_id=user_id,
            device_id=device_id,
            installed_id=installed_id,
            manual_retry=reset_failures,
        )
    result = await sync_global_capabilities(
        db,
        user_id,
        required_device_id=device_id,
        required_installed_kind_id=installed_id,
        require_device_success=False,
    )
    if any(item.get("stage") in {"global_ack", "snapshot"} for item in result.errors):
        return result
    return (
        await ensure_installed_plugin_on_device(
            db,
            user_id=user_id,
            device_id=device_id,
            installed_id=installed_id,
            previous=result,
            manual_retry=reset_failures,
        )
        or result
    )


@trace_async(span_name="plugins.sync_other_devices", tracer_name="backend.plugins")
async def sync_plugin_to_other_devices_after_change(
    user_id: int, installed_plugin_id: int, current_device_id: str | None
) -> None:
    """Converge the changed plugin without resending the initiating device."""
    try:
        with get_db_session() as db:
            devices = await device_service.get_online_devices(db, user_id)
            current = (
                resolve_plugin_runtime_device_id(
                    db, user_id=user_id, device_id=current_device_id
                )
                if current_device_id
                else None
            )
            if current_device_id and current is None:
                logger.info(
                    "Skipping background plugin sync without a unique current target: "
                    "user_id=%s installed_plugin_id=%s",
                    user_id,
                    installed_plugin_id,
                )
                return
            current_route = (
                resolve_runtime_route_identity(
                    db, user_id=user_id, submitted_device_id=current
                )
                if current
                else None
            )
            excluded = {current, current_device_id}
            if current_route:
                excluded.add(current_route.runtime_device_id)
            targets = []
            for device in devices:
                target = device_capability_sync_service._extract_device_id(device)
                if not target or target in excluded:
                    continue
                target = resolve_plugin_runtime_device_id(
                    db, user_id=user_id, device_id=target
                )
                if target is None:
                    continue
                route = resolve_runtime_route_identity(
                    db, user_id=user_id, submitted_device_id=target
                )
                if route and route.runtime_device_id in excluded:
                    continue
                target = plugin_device_id(db, user_id, target)
                if target not in excluded and target not in targets:
                    targets.append(target)
        schedule_other_devices(
            device_capability_sync_service,
            user_id=user_id,
            device_ids=targets,
            installed_plugin_ids=[installed_plugin_id],
        )
    except Exception:
        logger.exception(
            "Background plugin sync failed: user_id=%s installed_plugin_id=%s",
            user_id,
            installed_plugin_id,
        )


def _needs_device_install(
    db: Session, *, user_id: int, device_id: str, installed_id: int, manual_retry: bool
) -> bool:
    device_row = plugin_device_rows(db, user_id, device_id).get(installed_id)
    installed = db.get(Kind, installed_id)
    release_id = installed.json.get("spec", {}).get("releaseId") if installed else None
    if (
        device_row
        and device_row.state == "installed"
        and device_row.actual_release_id == release_id
        and device_row.desired_release_id == release_id
    ):
        return False
    return not (
        not manual_retry
        and device_row
        and plugin_device_installation_service.auto_update_blocked_release_id(
            device_row, desired_release_id=device_row.desired_release_id
        )
    )


@trace_async(
    span_name="plugins.ensure_device_installation", tracer_name="backend.plugins"
)
async def ensure_installed_plugin_on_device(
    db: Session,
    *,
    user_id: int,
    device_id: str | None,
    installed_id: int,
    previous: DeviceCapabilitySyncResponse | None = None,
    manual_retry: bool = False,
) -> DeviceCapabilitySyncResponse | None:
    try:
        if (
            device_id
            and previous
            and await run_plugin_operation(
                _has_current_plugin_snapshot,
                user_id=user_id,
                device_id=device_id,
                previous=previous,
            )
        ):
            return previous
        if not device_id or not await run_plugin_operation(
            _needs_device_install,
            user_id=user_id,
            device_id=device_id,
            installed_id=installed_id,
            manual_retry=manual_retry,
        ):
            return previous
    except PluginWriteError as exc:
        return deferred_plugin_sync(
            exc,
            user_id=user_id,
            device_id=device_id,
            previous=previous,
            stage="snapshot",
        )
    return await sync_installed_plugin_on_device(
        db,
        user_id=user_id,
        device_id=device_id,
        installed_id=installed_id,
        previous=previous,
    )


@trace_async(span_name="plugins.sync_device_plugin", tracer_name="backend.plugins")
async def sync_installed_plugin_on_device(
    db: Session,
    *,
    user_id: int,
    device_id: str | None,
    installed_id: int,
    previous: DeviceCapabilitySyncResponse | None = None,
) -> DeviceCapabilitySyncResponse | None:
    """Finish the requesting device's sync with a persisted, current ACK."""
    if not device_id:
        return previous
    result = previous
    for attempt in range(1, DESIRED_STATE_SYNC_ATTEMPTS + 1):
        result = await _sync_installed_plugin_once(
            db,
            user_id=user_id,
            device_id=device_id,
            installed_id=installed_id,
            previous=previous,
        )
        if result is None or not result.success:
            return result
        try:
            superseded = await run_plugin_operation(
                _plugin_ack_needs_reconciliation,
                user_id=user_id,
                device_id=device_id,
                installed_id=installed_id,
                response=result,
            )
        except PluginWriteError as exc:
            return deferred_plugin_sync(
                exc,
                user_id=user_id,
                device_id=device_id,
                stage="plugin_ack",
                previous=result,
            )
        if not superseded:
            return result
        logger.info(
            "Plugin ACK superseded before persistence; synchronizing current state: "
            "user_id=%s device_id=%s installed_id=%s attempt=%s",
            user_id,
            device_id,
            installed_id,
            attempt,
        )
        previous = result
    return deferred_plugin_sync(
        PluginWriteError("plugin_write_conflict"),
        user_id=user_id,
        device_id=device_id,
        stage="plugin_ack",
        previous=result,
    )


def _plugin_ack_needs_reconciliation(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    installed_id: int,
    response: DeviceCapabilitySyncResponse,
) -> bool:
    """A newer sent intent fences old ACKs even for an identical package."""
    if not _needs_device_install(
        db,
        user_id=user_id,
        device_id=device_id,
        installed_id=installed_id,
        manual_retry=False,
    ):
        return False
    canonical_id = plugin_device_id(db, user_id, device_id)
    for result in response.results:
        snapshot = result.desired_plugin_snapshot
        if (
            snapshot is None
            or plugin_device_id(db, user_id, result.device_id) != canonical_id
        ):
            continue
        state = lock_plugin_sync_state(db, user_id)
        generation = snapshot["plugin_sync"]["generation"]
        return generation < plugin_snapshot_watermark(state, canonical_id, installed_id)
    return False


async def _sync_installed_plugin_once(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    installed_id: int,
    previous: DeviceCapabilitySyncResponse | None,
) -> DeviceCapabilitySyncResponse | None:
    try:
        merge_sync = (
            await device_capability_sync_service.sync_installed_plugin_to_device_result(
                db,
                user_id=user_id,
                device_id=device_id,
                installed_plugin_id=installed_id,
            )
        )
    except PluginWriteError as exc:
        return deferred_plugin_sync(
            exc,
            user_id=user_id,
            device_id=device_id,
            previous=previous,
            stage="snapshot",
        )
    except Exception:
        logger.exception(
            "Single-plugin device sync failed after account change: "
            "user_id=%s device_id=%s installed_id=%s",
            user_id,
            device_id,
            installed_id,
        )
        if previous is None:
            return None
        return deferred_plugin_sync(
            PluginWriteError("plugin_device_sync_failed"),
            user_id=user_id,
            device_id=device_id,
            previous=previous,
            stage="snapshot",
        )
    finally:
        db.close()
    return await record_sync_response(
        merge_sync,
        user_id=user_id,
        device_id=device_id,
        stage="plugin_ack",
        installed_kind_id=installed_id,
    )


def _has_current_plugin_snapshot(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    previous: DeviceCapabilitySyncResponse,
) -> bool:
    """A v2 result for another device must not suppress the old-device retry."""
    return any(
        result.desired_plugin_snapshot is not None
        and plugin_device_id(db, user_id, result.device_id)
        == plugin_device_id(db, user_id, device_id)
        for result in previous.results
    )


async def record_sync_response(
    result: DeviceCapabilitySyncResponse,
    *,
    user_id: int,
    device_id: str | None,
    stage: str,
    installed_kind_id: int | None = None,
) -> DeviceCapabilitySyncResponse:
    operation = (
        partial(
            plugin_device_installation_service.record_plugin_sync_response,
            installed_kind_id=installed_kind_id,
        )
        if installed_kind_id is not None
        else plugin_device_installation_service.record_sync_response
    )
    try:
        await run_plugin_operation(
            operation,
            user_id=user_id,
            response=result,
        )
    except PluginWriteError as exc:
        return deferred_plugin_sync(
            exc, user_id=user_id, device_id=device_id, previous=result, stage=stage
        )
    return result


def _required_sync_failed(
    db: Session,
    *,
    user_id: int,
    result: DeviceCapabilitySyncResponse,
    device_id: str | None,
    installed_id: int | None,
    expect_installed: bool,
) -> bool:
    required_result = next(
        (
            item
            for item in result.results
            if device_id
            and plugin_device_id(db, user_id, item.device_id)
            == plugin_device_id(db, user_id, device_id)
        ),
        None,
    )
    if device_id and (not required_result or not required_result.success):
        return True
    if device_id and installed_id is not None:
        row = plugin_device_rows(db, user_id, device_id).get(installed_id)
        installed = db.get(Kind, installed_id)
        release_id = (
            installed.json.get("spec", {}).get("releaseId") if installed else None
        )
        materialized = bool(
            row and row.state == "installed" and row.actual_release_id == release_id
        )
        return materialized != expect_installed
    return False


@trace_async(span_name="plugins.sync_after_change", tracer_name="backend.plugins")
async def sync_global_capabilities(
    db: Session,
    user_id: int,
    *,
    required_device_id: str | None = None,
    required_installed_kind_id: int | None = None,
    expect_installed: bool = True,
    require_device_success: bool = True,
) -> DeviceCapabilitySyncResponse:
    try:
        if required_installed_kind_id is not None:
            from app.services.device.plugin_change_sync import (
                sync_changed_plugin_to_devices,
            )

            result = await sync_changed_plugin_to_devices(
                device_capability_sync_service,
                db,
                user_id=user_id,
                installed_plugin_id=required_installed_kind_id,
                current_device_id=required_device_id,
            )
        else:
            result = await device_capability_sync_service.sync_user_global_capabilities(
                db, user_id=user_id
            )
    except PluginWriteError as exc:
        return deferred_plugin_sync(
            exc, user_id=user_id, device_id=required_device_id, stage="snapshot"
        )
    finally:
        db.close()
    logger.info(
        "Global capability sync after plugin change completed: "
        "user_id=%s synced=%s failed=%s skipped=%s",
        user_id,
        result.synced,
        result.failed,
        result.skipped,
    )
    result = await record_sync_response(
        result, user_id=user_id, device_id=required_device_id, stage="global_ack"
    )
    if any(item.get("stage") == "global_ack" for item in result.errors):
        return result
    failed = await run_plugin_operation(
        _required_sync_failed,
        user_id=user_id,
        result=result,
        device_id=required_device_id,
        installed_id=required_installed_kind_id,
        expect_installed=expect_installed,
    )
    if failed and require_device_success:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "PLUGIN_DEVICE_SYNC_FAILED",
                "message": "Plugin saved but one or more devices failed to synchronize",
                "results": [item.model_dump() for item in result.results],
            },
        )
    if failed:
        logger.warning(
            "Device sync incomplete after plugin change: "
            "user_id=%s device_id=%s installed_kind_id=%s",
            user_id,
            required_device_id,
            required_installed_kind_id,
        )
    return result
