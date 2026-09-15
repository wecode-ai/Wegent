"""Reconcile account-managed plugins without changing independent capabilities."""

from typing import Any

from fastapi import HTTPException

from app.db.session import get_db_session
from app.schemas.device import DeviceCapabilitySyncResponse
from app.schemas.installed_plugin import PluginDeviceSyncResponse
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service
from shared.telemetry.decorators import trace_async


def desired_plugins(user_id: int, device_id: str) -> dict[str, Any]:
    with get_db_session() as db:
        plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
            db, user_id=user_id
        )

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


@trace_async(tracer_name="backend.plugins", span_name="reconcile_device_plugins")
async def reconcile_device_plugins(
    user_id: int, device_id: str
) -> PluginDeviceSyncResponse:
    payload = desired_plugins(user_id, device_id)
    # Re-read after the device round trip. An install/uninstall may have committed
    # while a package was downloading; never acknowledge an obsolete snapshot.
    for _ in range(3):
        result = await device_capability_sync_service.sync_device_payload(
            user_id=user_id, device_id=device_id, payload=payload
        )
        if (
            not result.success
            or result.errors
            or any(item.status == "failed" for item in result.plugins)
        ):
            raise HTTPException(
                502, "Plugin reconciliation failed on the current device"
            )
        if result.scope != "plugins":
            raise HTTPException(409, "Update the desktop runtime to reconcile plugins")
        latest = desired_plugins(user_id, device_id)
        if plugin_snapshot(latest) != plugin_snapshot(payload):
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
