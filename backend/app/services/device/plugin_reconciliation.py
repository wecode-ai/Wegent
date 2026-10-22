"""Reconcile account-managed plugins without changing independent capabilities."""

import asyncio
from typing import Any

from fastapi import HTTPException

from app.db.session import get_db_session
from app.schemas.device import DeviceCapabilitySyncResponse, DeviceCapabilitySyncResult
from app.schemas.installed_plugin import PluginDeviceSyncResponse
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.device.plugin_change_sync import dispatch_snapshot
from app.services.device.plugin_sync_protocol import load_versioned_plugin_payload
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service
from shared.telemetry.decorators import trace_async


def desired_plugins(user_id: int, device_id: str) -> dict[str, Any]:
    with get_db_session() as db:
        changed = plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
            db, user_id=user_id
        )
        if changed:
            db.commit()

        # Merge is intentional: older executors must never interpret omitted skills
        # and MCPs as a request to delete them. The scope acknowledgement is required.
        return device_capability_sync_service.build_desired_plugins(
            db, user_id=user_id, device_id=device_id
        )


def plugin_snapshot(payload: dict[str, Any]) -> list[dict[str, Any]]:
    # Signed URLs and their expiration change even when the installation does not.
    return sorted(
        [
            {
                key: value
                for key, value in plugin.items()
                if key not in {"download_path", "download_url_expires_at"}
            }
            for plugin in payload["plugins"]
        ],
        key=lambda plugin: str(plugin.get("installed_plugin_id")),
    )


def reconciliation_failure_detail(result: DeviceCapabilitySyncResult) -> str:
    failed = next((item for item in result.plugins if item.status == "failed"), None)
    if failed is not None:
        identity = failed.name or str(failed.id or "plugin")
        reason = (
            failed.error_code or failed.stage or failed.error or "device_sync_failed"
        )
        return f"Plugin reconciliation failed for {identity}: {reason}"
    if result.error:
        return f"Plugin reconciliation failed: {result.error}"
    return "Plugin reconciliation failed on the current device"


@trace_async(tracer_name="backend.plugins", span_name="reconcile_device_plugins")
async def reconcile_device_plugins(
    user_id: int, device_id: str
) -> PluginDeviceSyncResponse:
    versioned = await device_capability_sync_service.supports_plugin_delta(
        user_id, device_id
    )

    def load_payload() -> dict[str, Any]:
        if not versioned:
            return desired_plugins(user_id, device_id)
        return load_versioned_plugin_payload(
            get_db_session,
            user_id=user_id,
            complete=True,
            load_payload=lambda db: device_capability_sync_service.build_desired_plugins(
                db,
                user_id=user_id,
                device_id=device_id,
            ),
        )

    # Repair catalog references before taking the ordered complete snapshot.
    if versioned:
        await asyncio.to_thread(desired_plugins, user_id, device_id)
    payload = await asyncio.to_thread(load_payload)
    # Re-read after the device round trip. An install/uninstall may have committed
    # while a package was downloading; never acknowledge an obsolete snapshot.
    for _ in range(3):
        result = await dispatch_snapshot(
            device_capability_sync_service,
            user_id=user_id,
            device_id=device_id,
            payload=payload,
            timeout_seconds=180,
        )
        if (
            not result.success
            or result.errors
            or any(item.status == "failed" for item in result.plugins)
        ):
            raise HTTPException(502, reconciliation_failure_detail(result))
        if result.scope != "plugins":
            raise HTTPException(409, "Update the desktop runtime to reconcile plugins")
        latest = await asyncio.to_thread(load_payload)
        if plugin_snapshot(latest) != plugin_snapshot(payload) or any(
            item.status == "superseded" for item in result.plugins
        ):
            payload = latest
            continue
        with get_db_session() as db:
            plugin_device_installation_service.record_device_sync_result(
                db, user_id=user_id, result=result
            )
        return PluginDeviceSyncResponse(
            deviceId=device_id,
            pendingCount=0,
            reconciled=True,
            sync=DeviceCapabilitySyncResponse(
                success=True,
                device_id=device_id,
                mode="merge",
                plugins=result.plugins,
                results=[result],
                synced=1,
            ),
        )
    raise HTTPException(
        409, "Plugin installations changed during reconciliation; refresh again"
    )
