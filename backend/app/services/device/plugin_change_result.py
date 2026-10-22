# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Synchronize account plugin writes and assess initiating-device results."""

import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceCapabilitySyncResponse
from app.services.device.capability_sync_service import (
    DeviceCapabilityResolutionError,
    DeviceCapabilitySyncError,
    device_capability_sync_service,
)
from app.services.plugin_device_identity import plugin_device_id, plugin_device_rows
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


@trace_async(
    span_name="plugins.ensure_device_installation", tracer_name="backend.plugins"
)
async def _ensure_installed_plugin_on_device(
    db: Session,
    *,
    user_id: int,
    device_id: str | None,
    installed_id: int,
    previous: DeviceCapabilitySyncResponse | None = None,
    manual_retry: bool = False,
) -> DeviceCapabilitySyncResponse | None:
    """Preserve the legacy single-plugin retry after its full reconciliation."""
    if not device_id:
        return previous
    if previous and any(
        result.desired_plugin_snapshot is not None
        and plugin_device_id(db, user_id, result.device_id)
        == plugin_device_id(db, user_id, device_id)
        for result in previous.results
    ):
        return previous
    device_row = plugin_device_rows(db, user_id, device_id).get(installed_id)
    installed = db.get(Kind, installed_id)
    release_id = installed.json.get("spec", {}).get("releaseId") if installed else None
    if (
        device_row
        and device_row.state == "installed"
        and device_row.actual_release_id == release_id
        and device_row.desired_release_id == release_id
    ):
        return previous
    if (
        not manual_retry
        and device_row
        and plugin_device_installation_service.auto_update_blocked_release_id(
            device_row,
            desired_release_id=device_row.desired_release_id,
        )
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
    except (
        DeviceCapabilitySyncError,
        DeviceCapabilityResolutionError,
        Exception,
    ) as exc:
        logger.warning(
            "Single-plugin device sync failed after install: user_id=%s device_id=%s installed_id=%s error=%s",
            user_id,
            device_id,
            installed_id,
            exc,
        )
        return previous
    plugin_device_installation_service.record_plugin_sync_response(
        db, user_id=user_id, installed_kind_id=installed_id, response=merge_sync
    )
    return merge_sync


@trace_async(span_name="plugins.sync_after_change", tracer_name="backend.plugins")
async def _sync_global_capabilities(
    db: Session,
    user_id: int,
    *,
    required_device_id: str | None = None,
    required_installed_kind_id: int | None = None,
    expect_installed: bool = True,
    require_device_success: bool = True,
) -> DeviceCapabilitySyncResponse:
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
            db,
            user_id=user_id,
        )
    logger.info(
        "Global capability sync after plugin change completed: user_id=%s synced=%s failed=%s skipped=%s",
        user_id,
        result.synced,
        result.failed,
        result.skipped,
    )
    plugin_device_installation_service.record_sync_response(
        db, user_id=user_id, response=result
    )
    required_result = next(
        (
            item
            for item in result.results
            if required_device_id
            and plugin_device_id(db, user_id, item.device_id)
            == plugin_device_id(db, user_id, required_device_id)
        ),
        None,
    )
    required_device_failed = bool(
        required_device_id and (not required_result or not required_result.success)
    )
    required_materialization_failed = False
    if required_device_id and required_installed_kind_id is not None:
        device_row = plugin_device_rows(db, user_id, required_device_id).get(
            required_installed_kind_id
        )
        installed = db.get(Kind, required_installed_kind_id)
        release_id = (
            installed.json.get("spec", {}).get("releaseId") if installed else None
        )
        materialized = bool(
            device_row
            and device_row.state == "installed"
            and device_row.actual_release_id == release_id
        )
        required_materialization_failed = materialized != expect_installed
    if require_device_success and (
        required_device_failed or required_materialization_failed
    ):
        raise HTTPException(
            status_code=502,
            detail={
                "code": "PLUGIN_DEVICE_SYNC_FAILED",
                "message": "Plugin saved but one or more devices failed to synchronize",
                "results": [item.model_dump() for item in result.results],
            },
        )
    if not require_device_success and (
        required_device_failed or required_materialization_failed
    ):
        logger.warning(
            "Device sync incomplete after plugin change: user_id=%s device_id=%s installed_kind_id=%s",
            user_id,
            required_device_id,
            required_installed_kind_id,
        )
    return result
