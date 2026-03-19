# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device provider implementation.

Cloud devices currently share the same WebSocket connectivity and Redis-based
online tracking model as local devices. The main difference is that they are
filtered by `spec.deviceType == "cloud"` and expose `cloud_config` metadata.
"""

from typing import Any, Dict, List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.schemas.device import DeviceConnectionMode, DeviceType
from app.services.device.local_provider import LocalDeviceProvider
from app.services.device.version_service import executor_version_service


class CloudDeviceProvider(LocalDeviceProvider):
    """Provider for cloud devices connected through the executor WebSocket."""

    @property
    def device_type(self) -> DeviceType:
        """Return CLOUD device type."""
        return DeviceType.CLOUD

    async def get_status(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Get cloud device status from Redis and database."""
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
        if spec.get("deviceType") != DeviceType.CLOUD.value:
            return None

        online_info = await self._get_online_info(user_id, device_id)
        slot_info = await self.get_slot_usage(db, user_id, device_id)

        executor_version = online_info.get("executor_version") if online_info else None
        latest_version = (
            await executor_version_service.get_latest_version()
            or settings.EXECUTOR_LATEST_VERSION
        )
        update_available = self._is_update_available(executor_version, latest_version)

        return {
            "id": device_kind.id,
            "device_id": device_id,
            "name": spec.get("displayName") or device_id,
            "status": online_info.get("status", "online") if online_info else "offline",
            "is_default": spec.get("isDefault", False),
            "device_type": DeviceType.CLOUD.value,
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
            "update_available": update_available,
            "client_ip": spec.get("clientIp"),
            "cloud_config": spec.get("cloudConfig"),
        }

    async def list_devices(
        self,
        db: Session,
        user_id: int,
        include_offline: bool = True,
    ) -> List[Dict[str, Any]]:
        """List all cloud devices for a user."""
        from app.core.cache import cache_manager
        from app.schemas.device import MAX_DEVICE_SLOTS

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

        # Filter cloud devices
        cloud_devices = []
        for device_kind in devices:
            spec = device_kind.json.get("spec", {})
            if spec.get("deviceType") == DeviceType.CLOUD.value:
                cloud_devices.append(device_kind)

        if not cloud_devices:
            return []

        # Batch fetch online info from Redis using mget
        device_ids = [d.name for d in cloud_devices]
        redis_keys = [self.generate_online_key(user_id, did) for did in device_ids]
        online_info_map = await cache_manager.mget(redis_keys)

        # Build result list
        result = []
        latest_version = (
            await executor_version_service.get_latest_version()
            or settings.EXECUTOR_LATEST_VERSION
        )

        for i, device_kind in enumerate(cloud_devices):
            spec = device_kind.json.get("spec", {})
            device_id = device_kind.name
            redis_key = redis_keys[i]

            online_info = online_info_map.get(redis_key)
            is_online = online_info is not None

            if not include_offline and not is_online:
                continue

            # Get slot usage from cached online info (no extra Redis call)
            running_task_ids = []
            if online_info and "running_task_ids" in online_info:
                running_task_ids = online_info["running_task_ids"]

            executor_version = (
                online_info.get("executor_version") if online_info else None
            )
            update_available = self._is_update_available(
                executor_version, latest_version
            )

            result.append(
                {
                    "id": device_kind.id,
                    "device_id": device_id,
                    "name": spec.get("displayName") or device_id,
                    "status": (
                        online_info.get("status", "online")
                        if online_info
                        else "offline"
                    ),
                    "is_default": spec.get("isDefault", False),
                    "device_type": DeviceType.CLOUD.value,
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
                    "update_available": update_available,
                    "client_ip": spec.get("clientIp"),
                    "cloud_config": spec.get("cloudConfig"),
                }
            )

        return result
