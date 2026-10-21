"""Synchronize devices after an authoritative account plugin transaction."""

import logging
from functools import partial

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceCapabilitySyncResponse
from app.schemas.installed_plugin import InstalledPlugin
from app.services.device.capability_sync_service import (
    DeviceCapabilityResolutionError,
    DeviceCapabilitySyncError,
    device_capability_sync_service,
)
from app.services.plugin_device_identity import plugin_device_id, plugin_device_rows
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_write_errors import PluginWriteError
from app.services.plugin_write_operations import run_plugin_operation
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


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
) -> DeviceCapabilitySyncResponse:
    installed_id = int(installed.metadata["labels"]["id"])
    if sync_current_device_only and device_id is not None:
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
    result = await sync_global_capabilities(
        db,
        user_id,
        required_device_id=device_id,
        required_installed_kind_id=installed_id,
        require_device_success=False,
    )
    if any(item.get("stage") == "global_ack" for item in result.errors):
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
    if not device_id or not await run_plugin_operation(
        _needs_device_install,
        user_id=user_id,
        device_id=device_id,
        installed_id=installed_id,
        manual_retry=manual_retry,
    ):
        return previous
    try:
        merge_sync = (
            await device_capability_sync_service.sync_installed_plugin_to_device(
                db,
                user_id=user_id,
                device_id=device_id,
                installed_plugin_id=installed_id,
            )
        )
    except Exception:
        logger.exception(
            "Single-plugin device sync failed after install: "
            "user_id=%s device_id=%s installed_id=%s",
            user_id,
            device_id,
            installed_id,
        )
        return previous
    finally:
        db.close()
    return await record_sync_response(
        merge_sync,
        user_id=user_id,
        device_id=device_id,
        stage="plugin_ack",
        installed_kind_id=installed_id,
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
        result = await device_capability_sync_service.sync_user_global_capabilities(
            db, user_id=user_id
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
