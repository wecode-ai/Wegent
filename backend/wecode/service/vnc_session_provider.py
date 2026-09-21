# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Nevis VNC provider registered by the internal distribution."""

from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.schemas.device import DeviceType
from app.services.device.session_service import (
    DeviceSessionError,
    register_cloud_session_host_resolver,
)
from wecode.config.nevis_config import nevis_settings
from wecode.service.cloud_device_provider import cloud_device_provider
from wecode.service.vnc_session_service import (
    VncSessionRecord,
    VncUpstream,
    vnc_session_provider_registry,
)

NEVIS_READY_STATES = {"ready", "running"}


class NevisVncSessionProvider:
    """Resolve and live-check an owned Nevis sandbox for Backend proxying."""

    async def prepare(
        self,
        *,
        db: Any,
        user_id: int,
        device_id: str,
    ) -> VncUpstream:
        if not cloud_device_provider.is_configured():
            raise DeviceSessionError("Cloud device provider is not configured")
        device_status = await cloud_device_provider.get_status(
            db=db,
            user_id=user_id,
            device_id=device_id,
        )
        if not device_status:
            raise DeviceSessionError("Cloud device not found or access denied")
        cloud_config = device_status.get("cloud_config") or {}
        sandbox_id = str(cloud_config.get("sandboxId") or "").strip()
        if not sandbox_id:
            raise DeviceSessionError("Cloud device is missing its sandbox identity")

        live_status = await cloud_device_provider.get_vm_status(sandbox_id)
        state = str(live_status.get("status") or "").strip().lower()
        if state not in NEVIS_READY_STATES:
            raise DeviceSessionError("Cloud device desktop is not running")
        signature = nevis_settings.NEVIS_SIGNATURE.strip()
        if not signature:
            raise DeviceSessionError("Nevis VNC authentication is not configured")

        return VncUpstream(
            url=build_nevis_vnc_url(sandbox_id),
            headers={"X-Signature": signature},
            provider="nevis",
            provider_instance_id=sandbox_id,
        )

    async def authorize(
        self,
        *,
        db: Any,
        record: VncSessionRecord,
    ) -> VncUpstream:
        upstream = await self.prepare(
            db=db,
            user_id=record.owner_user_id,
            device_id=record.device_id,
        )
        if upstream.provider_instance_id != record.provider_instance_id:
            raise DeviceSessionError("Cloud device sandbox identity changed")
        return upstream


def build_nevis_vnc_url(sandbox_id: str) -> str:
    """Build the Backend-only Nevis WebSocket endpoint."""
    base = urlsplit(nevis_settings.NEVIS_BASE_URL.strip())
    if base.scheme not in {"http", "https"} or not base.netloc:
        raise DeviceSessionError("Nevis base URL is not configured")
    manager_id = nevis_settings.NEVIS_MANAGER_ID.strip()
    if not manager_id:
        raise DeviceSessionError("Nevis manager ID is not configured")
    scheme = "wss" if base.scheme == "https" else "ws"
    path = (
        f"{base.path.rstrip('/')}/apis/sandboxes/v1/managers/{manager_id}"
        f"/sandboxes/{sandbox_id}/vnc"
    )
    return urlunsplit((scheme, base.netloc, path, "", ""))


vnc_session_provider_registry.register(DeviceType.CLOUD, NevisVncSessionProvider())
register_cloud_session_host_resolver(cloud_device_provider.get_vm_status)
