# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Local device provider implementation.

Handles local devices that connect via WebSocket. This provider manages:
- Device registration via WebSocket connection
- Redis-based online state with TTL
- Heartbeat monitoring
- Task slot tracking
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from packaging import version as pkg_version
from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.kind import Kind
from app.schemas.device import (
    MAX_DEVICE_SLOTS,
    DeviceConnectionMode,
    DeviceType,
)
from app.services.device.base_provider import BaseDeviceProvider

logger = logging.getLogger(__name__)

# Redis key patterns and TTL
DEVICE_ONLINE_KEY_PREFIX = "device:online:"
DEVICE_ONLINE_TTL = 90  # seconds (heartbeat interval 30s x 3)


class LocalDeviceProvider(BaseDeviceProvider):
    """Provider for local devices connected via WebSocket.

    Local devices are user machines running the wegent-executor binary.
    They connect to the backend via WebSocket for bidirectional communication
    and execute tasks using Claude Code SDK locally.

    Features:
    - WebSocket-based persistent connection
    - Redis-backed online state with TTL (auto-offline on disconnect)
    - Heartbeat-based health monitoring
    - Concurrent task slot management (default 5 slots)
    """

    @property
    def device_type(self) -> DeviceType:
        """Return LOCAL device type."""
        return DeviceType.LOCAL

    @staticmethod
    def generate_online_key(user_id: int, device_id: str) -> str:
        """Generate Redis key for device online status."""
        return f"{DEVICE_ONLINE_KEY_PREFIX}{user_id}:{device_id}"

    async def register(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        name: str,
        socket_id: Optional[str] = None,
        executor_version: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
        client_ip: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Register a local device.

        Creates or updates the Device CRD and sets online status in Redis.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier
            name: Device display name
            socket_id: WebSocket session ID
            executor_version: Executor version string
            capabilities: Device capability tags
            client_ip: Device's client IP address

        Returns:
            Dict with device 'id' and 'is_default'
        """
        # Find existing device by Kind.name (device_id)
        device_kind = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == "Device",
                    Kind.namespace == "default",
                    Kind.name == device_id,
                )
            )
            .first()
        )

        is_first_device = False
        if device_kind:
            # Update existing device (reactivate if soft-deleted)
            device_json = device_kind.json.copy()
            device_json["spec"]["displayName"] = name
            device_json["spec"]["deviceType"] = DeviceType.LOCAL.value
            device_json["spec"]["connectionMode"] = DeviceConnectionMode.WEBSOCKET.value
            if capabilities is not None:
                device_json["spec"]["capabilities"] = capabilities
            if client_ip is not None:
                device_json["spec"]["clientIp"] = client_ip
            device_kind.json = device_json
            device_kind.updated_at = datetime.now()
            device_kind.is_active = True
            db.add(device_kind)
            logger.info(
                f"[LocalDeviceProvider] Updated device: user_id={user_id}, device_id={device_id}"
            )
        else:
            # Check if this is the first device for the user
            existing_count = (
                db.query(Kind)
                .filter(
                    and_(
                        Kind.user_id == user_id,
                        Kind.kind == "Device",
                        Kind.namespace == "default",
                        Kind.is_active == True,
                    )
                )
                .count()
            )
            is_first_device = existing_count == 0

            # Create new device CRD
            device_json = {
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Device",
                "metadata": {
                    "name": device_id,
                    "namespace": "default",
                    "displayName": name,
                },
                "spec": {
                    "deviceId": device_id,
                    "displayName": name,
                    "deviceType": DeviceType.LOCAL.value,
                    "connectionMode": DeviceConnectionMode.WEBSOCKET.value,
                    "isDefault": is_first_device,
                    "capabilities": capabilities,
                    "clientIp": client_ip,
                },
                "status": {
                    "state": "Available",
                },
            }

            device_kind = Kind(
                user_id=user_id,
                kind="Device",
                name=device_id,
                namespace="default",
                json=device_json,
            )
            db.add(device_kind)
            logger.info(
                f"[LocalDeviceProvider] Registered new device: user_id={user_id}, "
                f"device_id={device_id}, is_default={is_first_device}"
            )

        db.commit()
        db.refresh(device_kind)

        # Set online status in Redis
        if socket_id:
            await self._set_online(
                user_id=user_id,
                device_id=device_id,
                socket_id=socket_id,
                name=name,
                status="online",
                executor_version=executor_version,
            )

        return {
            "id": device_kind.id,
            "is_default": device_kind.json.get("spec", {}).get("isDefault", False),
        }

    async def _set_online(
        self,
        user_id: int,
        device_id: str,
        socket_id: str,
        name: str,
        status: str = "online",
        executor_version: Optional[str] = None,
    ) -> bool:
        """Set device online status in Redis."""
        key = self.generate_online_key(user_id, device_id)
        data = {
            "socket_id": socket_id,
            "name": name,
            "status": status,
            "last_heartbeat": datetime.now().isoformat(),
            "executor_version": executor_version,
        }
        result = await cache_manager.set(key, data, expire=DEVICE_ONLINE_TTL)
        logger.info(f"[LocalDeviceProvider] set_online: key={key}, result={result}")
        return result

    async def unregister(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> bool:
        """Unregister device (remove from Redis online state)."""
        key = self.generate_online_key(user_id, device_id)
        result = await cache_manager.delete(key)
        logger.info(f"[LocalDeviceProvider] unregister: key={key}, result={result}")
        return result

    async def get_status(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Get device status from Redis and database."""
        # Get CRD from database
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

        # Get online info from Redis
        online_info = await self._get_online_info(user_id, device_id)
        slot_info = await self.get_slot_usage(db, user_id, device_id)

        # Get version info
        executor_version = online_info.get("executor_version") if online_info else None
        latest_version = settings.EXECUTOR_LATEST_VERSION
        update_available = self._is_update_available(executor_version, latest_version)

        return {
            "id": device_kind.id,
            "device_id": device_id,
            "name": spec.get("displayName") or device_id,
            "status": online_info.get("status", "online") if online_info else "offline",
            "is_default": spec.get("isDefault", False),
            "device_type": spec.get("deviceType", DeviceType.LOCAL.value),
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
        }

    async def _get_online_info(
        self,
        user_id: int,
        device_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Get device online info from Redis."""
        key = self.generate_online_key(user_id, device_id)
        result = await cache_manager.get(key)
        logger.debug(
            f"[LocalDeviceProvider] get_online_info: key={key}, found={result is not None}"
        )
        return result

    async def list_devices(
        self,
        db: Session,
        user_id: int,
        include_offline: bool = True,
    ) -> List[Dict[str, Any]]:
        """List all local devices for a user."""
        # Get all Device CRDs for user
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

        result = []
        for device_kind in devices:
            device_json = device_kind.json
            spec = device_json.get("spec", {})
            device_id = device_kind.name

            # Skip non-local devices (future-proofing)
            device_type = spec.get("deviceType", DeviceType.LOCAL.value)
            if device_type != DeviceType.LOCAL.value:
                continue

            # Get online status from Redis
            online_info = await self._get_online_info(user_id, device_id)

            # Skip offline devices if requested
            is_online = online_info is not None
            if not include_offline and not is_online:
                continue

            # Get slot usage
            slot_info = await self.get_slot_usage(db, user_id, device_id)

            # Get version info
            executor_version = (
                online_info.get("executor_version") if online_info else None
            )
            latest_version = settings.EXECUTOR_LATEST_VERSION
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
                    "device_type": device_type,
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
                }
            )

        return result

    async def refresh_heartbeat(
        self,
        user_id: int,
        device_id: str,
        running_task_ids: Optional[List[int]] = None,
        executor_version: Optional[str] = None,
    ) -> bool:
        """Refresh device heartbeat in Redis."""
        key = self.generate_online_key(user_id, device_id)
        data = await cache_manager.get(key)
        if data:
            data["last_heartbeat"] = datetime.now().isoformat()
            if running_task_ids is not None:
                data["running_task_ids"] = running_task_ids
            if executor_version is not None:
                data["executor_version"] = executor_version
            result = await cache_manager.set(key, data, expire=DEVICE_ONLINE_TTL)
            logger.debug(
                f"[LocalDeviceProvider] refresh_heartbeat: key={key}, "
                f"running_tasks={len(running_task_ids) if running_task_ids else 0}"
            )
            return result
        logger.warning(
            f"[LocalDeviceProvider] refresh_heartbeat: key={key} not found in Redis"
        )
        return False

    async def is_online(
        self,
        user_id: int,
        device_id: str,
    ) -> bool:
        """Check if device is online."""
        info = await self._get_online_info(user_id, device_id)
        return info is not None

    async def get_slot_usage(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Dict[str, Any]:
        """Get slot usage information for a device."""
        from app.models.task import TaskResource

        # Get device online info from Redis (includes running_task_ids)
        device_info = await self._get_online_info(user_id, device_id)

        running_task_ids = []
        if device_info and "running_task_ids" in device_info:
            running_task_ids = device_info["running_task_ids"]

        # Query task details from database
        running_tasks = []
        if running_task_ids:
            tasks = (
                db.query(TaskResource)
                .filter(
                    and_(
                        TaskResource.id.in_(running_task_ids),
                        TaskResource.kind == "Task",
                    )
                )
                .all()
            )

            for task in tasks:
                try:
                    from app.schemas.kind import Task as TaskCRD

                    task_crd = TaskCRD.model_validate(task.json)
                    running_tasks.append(
                        {
                            "task_id": task.id,
                            "subtask_id": 0,
                            "title": task_crd.spec.title,
                            "status": (
                                task_crd.status.status if task_crd.status else "UNKNOWN"
                            ),
                            "created_at": (
                                task_crd.status.createdAt.isoformat()
                                if task_crd.status and task_crd.status.createdAt
                                else None
                            ),
                        }
                    )
                except Exception as e:
                    logger.warning(
                        f"[LocalDeviceProvider] Failed to parse task {task.id}: {e}"
                    )

        return {
            "used": len(running_task_ids),
            "max": MAX_DEVICE_SLOTS,
            "running_tasks": running_tasks,
        }

    async def update_status(
        self,
        user_id: int,
        device_id: str,
        status: str,
    ) -> bool:
        """Update device status in Redis."""
        key = self.generate_online_key(user_id, device_id)
        data = await cache_manager.get(key)
        if data:
            data["status"] = status
            data["last_heartbeat"] = datetime.now().isoformat()
            result = await cache_manager.set(key, data, expire=DEVICE_ONLINE_TTL)
            logger.debug(
                f"[LocalDeviceProvider] update_status: key={key}, status={status}"
            )
            return result
        return False

    @staticmethod
    def _is_update_available(current: Optional[str], latest: str) -> bool:
        """Check if update is available using semantic version comparison."""
        if not current:
            return True
        try:
            return pkg_version.parse(current) < pkg_version.parse(latest)
        except Exception:
            return False


# Singleton instance
local_device_provider = LocalDeviceProvider()
