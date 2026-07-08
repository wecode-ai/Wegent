# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Remote device provider implementation.

Remote devices are user-managed machines or containers that connect to Wegent
through the same executor WebSocket protocol as local devices. Wegent does not
own their lifecycle; it only stores connection metadata and dispatches work.
"""

from typing import Any, Dict, List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.kind import Kind
from app.schemas.device import MAX_DEVICE_SLOTS, DeviceConnectionMode, DeviceType
from app.services.device.local_provider import LocalDeviceProvider
from app.services.device.version_service import executor_version_service


class RemoteDeviceProvider(LocalDeviceProvider):
    """Provider for user-managed remote devices connected by WebSocket."""

    @property
    def device_type(self) -> DeviceType:
        """Return REMOTE device type."""
        return DeviceType.REMOTE

    async def get_status(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Get remote device status from Redis and database."""
        device_kind = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == "Device",
                    Kind.namespace == "default",
                    Kind.name == device_id,
                    Kind.is_active == True,
                )
            )
            .first()
        )

        if not device_kind:
            return None

        spec = device_kind.json.get("spec", {})
        if spec.get("deviceType") != DeviceType.REMOTE.value:
            return None

        online_info = await self._get_online_info(user_id, device_id)
        slot_info = await self.get_slot_usage(db, user_id, device_id)
        executor_version = online_info.get("executor_version") if online_info else None
        latest_version = (
            await executor_version_service.get_latest_version()
            or settings.EXECUTOR_LATEST_VERSION
        )

        return {
            "id": device_kind.id,
            "device_id": device_id,
            "name": spec.get("displayName") or device_id,
            "status": online_info.get("status", "online") if online_info else "offline",
            "is_default": spec.get("isDefault", False),
            "device_type": DeviceType.REMOTE.value,
            "connection_mode": spec.get(
                "connectionMode", DeviceConnectionMode.WEBSOCKET.value
            ),
            "capabilities": spec.get("capabilities"),
            "last_heartbeat": (
                online_info.get("last_heartbeat") if online_info else None
            ),
            "slot_used": slot_info["used"],
            "slot_max": slot_info["max"],
            "running_tasks": slot_info["running_tasks"],
            "executor_version": executor_version,
            "latest_version": latest_version,
            "update_available": self._is_update_available(
                executor_version, latest_version
            ),
            "client_ip": spec.get("clientIp"),
            "runtime_instance_id": spec.get("runtimeInstanceId"),
            "remote_config": spec.get("remoteConfig"),
            "bind_shell": spec.get("bindShell", "claudecode"),
        }

    async def list_devices(
        self,
        db: Session,
        user_id: int,
        include_offline: bool = True,
    ) -> List[Dict[str, Any]]:
        """List all remote devices for a user."""
        devices = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == "Device",
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
            )
            .all()
        )
        remote_devices = [
            device
            for device in devices
            if device.json.get("spec", {}).get("deviceType") == DeviceType.REMOTE.value
        ]
        if not remote_devices:
            return []

        redis_keys = [
            self.generate_online_key(user_id, device.name) for device in remote_devices
        ]
        online_info_map = await cache_manager.mget(redis_keys)
        latest_version = (
            await executor_version_service.get_latest_version()
            or settings.EXECUTOR_LATEST_VERSION
        )

        result: List[Dict[str, Any]] = []
        for index, device_kind in enumerate(remote_devices):
            spec = device_kind.json.get("spec", {})
            online_info = online_info_map.get(redis_keys[index])
            if not include_offline and not online_info:
                continue

            running_task_ids = []
            if online_info and "running_task_ids" in online_info:
                running_task_ids = online_info["running_task_ids"]

            executor_version = (
                online_info.get("executor_version") if online_info else None
            )
            result.append(
                {
                    "id": device_kind.id,
                    "device_id": device_kind.name,
                    "name": spec.get("displayName") or device_kind.name,
                    "status": (
                        online_info.get("status", "online")
                        if online_info
                        else "offline"
                    ),
                    "is_default": spec.get("isDefault", False),
                    "device_type": DeviceType.REMOTE.value,
                    "connection_mode": spec.get(
                        "connectionMode", DeviceConnectionMode.WEBSOCKET.value
                    ),
                    "capabilities": spec.get("capabilities"),
                    "last_heartbeat": (
                        online_info.get("last_heartbeat") if online_info else None
                    ),
                    "slot_used": len(running_task_ids),
                    "slot_max": MAX_DEVICE_SLOTS,
                    "running_tasks": [],
                    "executor_version": executor_version,
                    "latest_version": latest_version,
                    "update_available": self._is_update_available(
                        executor_version, latest_version
                    ),
                    "client_ip": spec.get("clientIp"),
                    "runtime_instance_id": spec.get("runtimeInstanceId"),
                    "remote_config": spec.get("remoteConfig"),
                    "bind_shell": spec.get("bindShell", "claudecode"),
                }
            )

        return result


remote_device_provider = RemoteDeviceProvider()
