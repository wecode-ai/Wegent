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
from app.schemas.device import DeviceConnectionMode, DeviceType
from app.services.device.base_provider import BaseDeviceProvider
from app.services.device.identity import (
    matching_online_info,
    owned_active_device,
    record_route_id,
)
from app.services.device.version_service import executor_version_service

logger = logging.getLogger(__name__)

# Redis key patterns and TTL
DEVICE_ONLINE_KEY_PREFIX = "device:online:"
DEVICE_ONLINE_TTL = 90  # seconds (heartbeat interval 30s x 3)
DEVICE_CAPABILITIES_KEY_PREFIX = "device:capabilities:"
DEVICE_CAPABILITIES_TTL = 600


def runtime_capacity_slot_values(online_info: Any) -> tuple[int, int]:
    if not isinstance(online_info, dict):
        return 0, 0
    capacity = online_info.get("runtime_capacity")
    if not isinstance(capacity, dict):
        return 0, 0
    active = capacity.get("active")
    active_task_ids = capacity.get("active_task_ids")
    limit = capacity.get("limit")
    if not isinstance(active, int) or isinstance(active, bool) or active < 0:
        return 0, 0
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
        return 0, 0
    if (
        not isinstance(active_task_ids, list)
        or len(active_task_ids) != active
        or len(set(active_task_ids)) != len(active_task_ids)
        or any(
            not isinstance(task_id, str) or not task_id for task_id in active_task_ids
        )
    ):
        return 0, 0
    return active, limit


class LocalDeviceProvider(BaseDeviceProvider):
    """Provider for local devices connected via WebSocket.

    Local devices are user machines running the wegent-executor binary.
    They connect to the backend via WebSocket for bidirectional communication
    and execute tasks using Claude Code SDK locally.

    Features:
    - WebSocket-based persistent connection
    - Redis-backed online state with TTL (auto-offline on disconnect)
    - Heartbeat-based health monitoring
    - Runtime-reported task capacity
    """

    @property
    def device_type(self) -> DeviceType:
        """Return LOCAL device type."""
        return DeviceType.LOCAL

    @staticmethod
    def generate_online_key(user_id: int, device_id: str) -> str:
        """Generate Redis key for device online status."""
        return f"{DEVICE_ONLINE_KEY_PREFIX}{user_id}:{device_id}"

    @staticmethod
    def generate_capabilities_key(user_id: int, device_id: str) -> str:
        """Generate Redis key for device global capability state."""
        return f"{DEVICE_CAPABILITIES_KEY_PREFIX}{user_id}:{device_id}"

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
        runtime_transfer_host: Optional[str] = None,
        runtime_instance_id: Optional[str] = None,
        app_device_id: Optional[str] = None,
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
            runtime_transfer_host: Host peers should use for direct transfers

        Returns:
            Dict with device 'id' and 'is_default'
        """
        from app.services.device_service import device_service

        device_kind = device_service.upsert_device_crd(
            db,
            user_id,
            device_id,
            name,
            device_type=self.device_type.value,
            capabilities=capabilities,
            client_ip=client_ip,
            runtime_transfer_host=runtime_transfer_host,
            runtime_instance_id=runtime_instance_id,
            app_device_id=app_device_id,
        )

        # Set online status in Redis
        if socket_id:
            await self._set_online(
                user_id=user_id,
                device_id=record_route_id(device_kind),
                socket_id=socket_id,
                name=name,
                status="online",
                executor_version=executor_version,
                client_ip=client_ip,
                runtime_transfer_host=runtime_transfer_host,
                runtime_instance_id=runtime_instance_id,
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
        client_ip: Optional[str] = None,
        runtime_transfer_host: Optional[str] = None,
        runtime_instance_id: Optional[str] = None,
        runtime_features: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Set device online status in Redis."""
        key = self.generate_online_key(user_id, device_id)
        data = {
            "socket_id": socket_id,
            "name": name,
            "status": status,
            "last_heartbeat": datetime.now().isoformat(),
            "executor_version": executor_version,
            "client_ip": client_ip,
            "runtime_transfer_host": runtime_transfer_host,
            "runtime_instance_id": runtime_instance_id,
            "runtime_features": runtime_features,
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
        device_kind = owned_active_device(db, user_id, device_id)

        if not device_kind:
            return None

        spec = device_kind.json.get("spec", {})
        if spec.get("deviceType", DeviceType.LOCAL.value) != self.device_type.value:
            return None

        # Get online info from Redis
        online_info = matching_online_info(
            spec, await self._get_online_info(user_id, record_route_id(device_kind))
        )
        slot_info = self._build_slot_usage(
            db,
            online_info.get("running_task_ids") if online_info else None,
            online_info,
        )

        # Get version info
        executor_version = online_info.get("executor_version") if online_info else None
        latest_version = (
            await executor_version_service.get_latest_version()
            or settings.EXECUTOR_LATEST_VERSION
        )
        update_available = self._is_update_available(executor_version, latest_version)

        return {
            "id": device_kind.id,
            "device_id": device_id,
            "execution_target_id": (
                record_route_id(device_kind)
                if self.device_type == DeviceType.APP
                else None
            ),
            "socket_device_id": (
                record_route_id(device_kind)
                if self.device_type == DeviceType.APP
                else None
            ),
            "name": spec.get("displayName") or device_id,
            "status": online_info.get("status", "online") if online_info else "offline",
            "is_default": spec.get("isDefault", False),
            "device_type": spec.get("deviceType", self.device_type.value),
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
            "runtime_transfer_host": spec.get("runtimeTransferHost"),
            "runtime_instance_id": spec.get("runtimeInstanceId"),
            "app_device_id": spec.get("appDeviceId"),
            "runtime_features": (
                online_info.get("runtime_features") if online_info else None
            ),
            "bind_shell": spec.get("bindShell", "claudecode"),
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

    async def store_capabilities_state(
        self,
        user_id: int,
        device_id: str,
        capabilities: Dict[str, Any],
    ) -> bool:
        """Store sanitized local global capability state reported by heartbeat."""
        key = self.generate_capabilities_key(user_id, device_id)
        payload = dict(capabilities)
        payload["reported_at"] = datetime.now().isoformat()
        return await cache_manager.set(key, payload, expire=DEVICE_CAPABILITIES_TTL)

    async def get_capabilities_state(
        self, user_id: int, device_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get the latest sanitized global capability state for a device."""
        return await cache_manager.get(
            self.generate_capabilities_key(user_id, device_id)
        )

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

        # Filter local devices and collect device IDs
        local_devices = []
        for device_kind in devices:
            spec = device_kind.json.get("spec", {})
            device_type = spec.get("deviceType", DeviceType.LOCAL.value)
            if device_type == self.device_type.value:
                local_devices.append(device_kind)

        if not local_devices:
            return []

        # Batch fetch online info from Redis using mget
        device_ids = [record_route_id(d) for d in local_devices]
        redis_keys = [self.generate_online_key(user_id, did) for did in device_ids]
        online_info_map = await cache_manager.mget(redis_keys)

        # Build result list
        result = []
        latest_version = (
            await executor_version_service.get_latest_version()
            or settings.EXECUTOR_LATEST_VERSION
        )

        for i, device_kind in enumerate(local_devices):
            device_json = device_kind.json
            spec = device_json.get("spec", {})
            device_id = device_kind.name
            redis_key = redis_keys[i]

            online_info = matching_online_info(spec, online_info_map.get(redis_key))
            is_online = online_info is not None

            # Skip offline devices if requested
            if not include_offline and not is_online:
                continue

            # Get slot usage from cached online info (no extra Redis call)
            running_task_ids = []
            if online_info and "running_task_ids" in online_info:
                running_task_ids = online_info["running_task_ids"]
            slot_used, slot_max = runtime_capacity_slot_values(online_info)

            # Get version info
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
                    "execution_target_id": (
                        record_route_id(device_kind)
                        if self.device_type == DeviceType.APP
                        else None
                    ),
                    "socket_device_id": (
                        record_route_id(device_kind)
                        if self.device_type == DeviceType.APP
                        else None
                    ),
                    "name": spec.get("displayName") or device_id,
                    "status": (
                        online_info.get("status", "online")
                        if online_info
                        else "offline"
                    ),
                    "is_default": spec.get("isDefault", False),
                    "device_type": self.device_type.value,
                    "connection_mode": spec.get(
                        "connectionMode", DeviceConnectionMode.WEBSOCKET.value
                    ),
                    "capabilities": spec.get("capabilities"),
                    "last_heartbeat": (
                        online_info.get("last_heartbeat") if online_info else None
                    ),
                    "slot_used": slot_used,
                    "slot_max": slot_max,
                    "running_tasks": [],
                    "executor_version": executor_version,
                    "latest_version": latest_version,
                    "update_available": update_available,
                    "client_ip": spec.get("clientIp"),
                    "runtime_transfer_host": spec.get("runtimeTransferHost"),
                    "runtime_instance_id": spec.get("runtimeInstanceId"),
                    "app_device_id": spec.get("appDeviceId"),
                    "runtime_features": (
                        online_info.get("runtime_features") if online_info else None
                    ),
                    "bind_shell": spec.get("bindShell", "claudecode"),
                }
            )

        return result

    async def refresh_heartbeat(
        self,
        user_id: int,
        device_id: str,
        running_task_ids: Optional[List[int]] = None,
        executor_version: Optional[str] = None,
        runtime_transfer_host: Optional[str] = None,
        runtime_instance_id: Optional[str] = None,
        runtime_capacity: Optional[Dict[str, Any]] = None,
        runtime_features: Optional[Dict[str, Any]] = None,
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
            if runtime_transfer_host is not None:
                data["runtime_transfer_host"] = runtime_transfer_host
            # Every heartbeat replaces the capacity observation. A missing
            # snapshot must clear the previous value instead of extending a
            # stale capacity truth with the online TTL.
            data["runtime_instance_id"] = runtime_instance_id
            data["runtime_capacity"] = runtime_capacity
            data["runtime_features"] = runtime_features
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

    @staticmethod
    def _build_slot_usage(
        db: Session,
        running_task_ids: Optional[List[int]],
        online_info: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build slot usage payload from reported task IDs."""
        from app.stores.tasks import task_store

        running_task_ids = running_task_ids or []

        running_tasks = []
        if running_task_ids:
            tasks = task_store.list_by_ids(db, task_ids=running_task_ids)

            for task in tasks:
                if task.kind != "Task":
                    continue
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

        slot_used, slot_max = runtime_capacity_slot_values(online_info)
        return {
            "used": slot_used,
            "max": slot_max,
            "running_tasks": running_tasks,
        }

    async def get_slot_usage(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Dict[str, Any]:
        """Get slot usage information for a device."""
        # Get device online info from Redis (includes running_task_ids)
        device_info = await self._get_online_info(user_id, device_id)

        running_task_ids = []
        if device_info and "running_task_ids" in device_info:
            running_task_ids = device_info["running_task_ids"]

        return self._build_slot_usage(db, running_task_ids, device_info)

    def get_slot_usage_sync(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Dict[str, Any]:
        """Get slot usage information for sync callers."""
        device_info = cache_manager.get_sync(
            self.generate_online_key(user_id, device_id)
        )

        running_task_ids = []
        if device_info and "running_task_ids" in device_info:
            running_task_ids = device_info["running_task_ids"]

        return self._build_slot_usage(db, running_task_ids, device_info)

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


class AppDeviceProvider(LocalDeviceProvider):
    """Provider for the desktop app's current local executor cloud registration."""

    @property
    def device_type(self) -> DeviceType:
        """Return APP device type."""
        return DeviceType.APP


app_device_provider = AppDeviceProvider()
