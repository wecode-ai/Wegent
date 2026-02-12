# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device provider implementation.

Handles cloud devices managed through Nevis Sandbox API. Cloud devices are
virtual machines that run wegent-executor and connect via WebSocket, similar
to local devices, but their lifecycle is managed through Nevis API.

Key features:
- Device creation via Nevis Sandbox API
- Device deletion via Nevis API
- Online state via Redis (same as local devices)
- Task execution via WebSocket (same as local devices)
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

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
from wecode.config.nevis_config import nevis_settings
from wecode.service.cloud_device_script import generate_simple_startup_script
from wecode.service.nevis_client import NevisClient, NevisClientError, nevis_client

logger = logging.getLogger(__name__)

# Redis key patterns and TTL (same as local devices)
DEVICE_ONLINE_KEY_PREFIX = "device:online:"
DEVICE_ONLINE_TTL = 90  # seconds


class CloudDeviceProvider(BaseDeviceProvider):
    """Provider for cloud devices managed through Nevis Sandbox API.

    Cloud devices are VMs created via Nevis API with pre-installed
    wegent-executor. Once started, the executor connects to the backend
    via WebSocket, just like local devices.

    Features:
    - Nevis API-based VM lifecycle management
    - Cloud-init script for automatic executor startup
    - WebSocket-based task execution (same as local)
    - Redis-backed online state with TTL
    """

    def __init__(self, client: Optional[NevisClient] = None):
        """Initialize cloud device provider.

        Args:
            client: Optional Nevis client instance (defaults to singleton)
        """
        self._client = client or nevis_client

    @property
    def device_type(self) -> DeviceType:
        """Return CLOUD device type."""
        return DeviceType.CLOUD

    @staticmethod
    def generate_online_key(user_id: int, device_id: str) -> str:
        """Generate Redis key for device online status."""
        return f"{DEVICE_ONLINE_KEY_PREFIX}{user_id}:{device_id}"

    def is_configured(self) -> bool:
        """Check if cloud device provider is properly configured.

        Returns:
            True if Nevis API is configured
        """
        return self._client.is_configured()

    async def create_device(
        self,
        db: Session,
        user_id: int,
        user_name: str,
        auth_token: str,
        backend_url: str,
    ) -> Dict[str, Any]:
        """Create a new cloud device via Nevis API.

        Args:
            db: Database session
            user_id: Device owner user ID
            user_name: User name for device naming
            auth_token: Auth token for executor to connect
            backend_url: Backend URL for executor connection

        Returns:
            Dict with device info including id, device_id, name, status

        Raises:
            ValueError: If limit reached or configuration error
            NevisClientError: If Nevis API call fails
        """
        if not self.is_configured():
            raise ValueError("Cloud device provider is not configured")

        # Check user's cloud device limit
        current_count = await self._get_user_cloud_device_count(db, user_id)
        max_devices = nevis_settings.NEVIS_MAX_DEVICES_PER_USER

        if current_count >= max_devices:
            raise ValueError(
                f"Cloud device limit reached: {current_count}/{max_devices}"
            )

        # Generate startup script
        # Use a placeholder device_id that will be replaced with sandbox_id
        temp_device_id = f"cloud-{user_id}-pending"
        user_data = generate_simple_startup_script(
            device_id=temp_device_id,
            user_name=user_name,
            backend_url=backend_url,
            auth_token=auth_token,
        )

        # Create sandbox via Nevis API
        logger.info(
            f"[CloudDeviceProvider] Creating cloud device for user_id={user_id}"
        )
        result = await self._client.create_sandbox(user_data=user_data)

        # Extract sandbox ID from response
        sandbox_id = result.get("id") or result.get("sandboxId")
        if not sandbox_id:
            raise NevisClientError("Nevis API did not return sandbox ID")

        # Create Device CRD with sandbox_id as device_id
        device_name = f"{user_name}-cloud-{sandbox_id[-8:]}"
        device_kind = await self._create_device_crd(
            db=db,
            user_id=user_id,
            device_id=sandbox_id,
            name=device_name,
            sandbox_id=sandbox_id,
            image_id=nevis_settings.NEVIS_IMAGE_ID,
        )

        logger.info(
            f"[CloudDeviceProvider] Cloud device created: user_id={user_id}, "
            f"sandbox_id={sandbox_id}, device_id={sandbox_id}"
        )

        return {
            "id": device_kind.id,
            "device_id": sandbox_id,
            "name": device_name,
            "status": "offline",
            "device_type": DeviceType.CLOUD.value,
            "message": "Cloud device created, waiting for executor to connect",
        }

    async def _create_device_crd(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        name: str,
        sandbox_id: str,
        image_id: str,
    ) -> Kind:
        """Create Device CRD for cloud device.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device ID (same as sandbox_id)
            name: Device display name
            sandbox_id: Nevis sandbox ID
            image_id: Image ID used for VM

        Returns:
            Created Kind model instance
        """
        # Check if this is the first device for the user (across all types)
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
                "deviceType": DeviceType.CLOUD.value,
                "connectionMode": DeviceConnectionMode.WEBSOCKET.value,
                "isDefault": is_first_device,
                "capabilities": None,
                "cloudConfig": {
                    "sandboxId": sandbox_id,
                    "imageId": image_id,
                    "createdAt": datetime.now().isoformat(),
                },
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
        db.commit()
        db.refresh(device_kind)

        return device_kind

    async def _get_user_cloud_device_count(
        self,
        db: Session,
        user_id: int,
    ) -> int:
        """Get count of user's active cloud devices.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Number of active cloud devices
        """
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

        count = 0
        for device in devices:
            spec = device.json.get("spec", {})
            if spec.get("deviceType") == DeviceType.CLOUD.value:
                count += 1

        return count

    async def delete_device(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> bool:
        """Delete a cloud device via Nevis API.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device ID (sandbox ID)

        Returns:
            True if deleted successfully
        """
        # Get device CRD
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
            logger.warning(
                f"[CloudDeviceProvider] Device not found: user_id={user_id}, "
                f"device_id={device_id}"
            )
            return False

        # Verify it's a cloud device
        spec = device_kind.json.get("spec", {})
        if spec.get("deviceType") != DeviceType.CLOUD.value:
            logger.warning(
                f"[CloudDeviceProvider] Device is not a cloud device: "
                f"device_id={device_id}, type={spec.get('deviceType')}"
            )
            return False

        # Get sandbox ID from cloudConfig
        cloud_config = spec.get("cloudConfig", {})
        sandbox_id = cloud_config.get("sandboxId", device_id)

        # Delete sandbox via Nevis API
        try:
            await self._client.delete_sandbox(sandbox_id)
            logger.info(f"[CloudDeviceProvider] Nevis sandbox deleted: {sandbox_id}")
        except NevisClientError as e:
            if e.status_code != 404:
                logger.error(
                    f"[CloudDeviceProvider] Failed to delete Nevis sandbox: {e}"
                )
                raise

        # Soft delete Device CRD
        device_kind.is_active = False
        db.commit()

        # Clean up Redis online status
        await self.unregister(db, user_id, device_id)

        logger.info(
            f"[CloudDeviceProvider] Cloud device deleted: user_id={user_id}, "
            f"device_id={device_id}"
        )

        return True

    async def get_nevis_status(
        self,
        device_id: str,
    ) -> Dict[str, Any]:
        """Get Nevis sandbox status.

        Args:
            device_id: Device ID (sandbox ID)

        Returns:
            Nevis sandbox status information
        """
        result = await self._client.get_sandbox(device_id)

        return {
            "sandbox_id": result.get("id", device_id),
            "status": result.get("status", "unknown"),
            "ip_address": result.get("ip") or result.get("ipAddress"),
            "created_at": result.get("createdAt"),
        }

    # ========================================================================
    # The following methods implement the BaseDeviceProvider interface.
    # They use the same Redis-based mechanism as LocalDeviceProvider.
    # ========================================================================

    async def register(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        name: str,
        socket_id: Optional[str] = None,
        executor_version: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Register a cloud device (called when executor connects via WebSocket).

        For cloud devices, the CRD should already exist (created via create_device).
        This method just updates the online status in Redis.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier (sandbox ID)
            name: Device display name
            socket_id: WebSocket session ID
            executor_version: Executor version string
            capabilities: Device capability tags

        Returns:
            Dict with device 'id' and 'is_default'
        """
        # Find existing cloud device CRD
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

        if device_kind:
            # Update existing device
            device_json = device_kind.json.copy()
            device_json["spec"]["displayName"] = name
            if capabilities is not None:
                device_json["spec"]["capabilities"] = capabilities
            device_kind.json = device_json
            device_kind.updated_at = datetime.now()
            db.add(device_kind)
            db.commit()
            db.refresh(device_kind)

            logger.info(
                f"[CloudDeviceProvider] Updated cloud device on register: "
                f"user_id={user_id}, device_id={device_id}"
            )
        else:
            # This shouldn't happen for cloud devices - they should be created first
            logger.warning(
                f"[CloudDeviceProvider] Cloud device not found during register: "
                f"user_id={user_id}, device_id={device_id}"
            )
            return {"id": 0, "is_default": False}

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
        logger.info(f"[CloudDeviceProvider] set_online: key={key}, result={result}")
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
        logger.info(f"[CloudDeviceProvider] unregister: key={key}, result={result}")
        return result

    async def get_status(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Get device status from Redis and database."""
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

        # Verify it's a cloud device
        if spec.get("deviceType") != DeviceType.CLOUD.value:
            return None

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
            "device_type": DeviceType.CLOUD.value,
            "connection_mode": DeviceConnectionMode.WEBSOCKET.value,
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
            "cloud_config": spec.get("cloudConfig"),
        }

    async def _get_online_info(
        self,
        user_id: int,
        device_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Get device online info from Redis."""
        key = self.generate_online_key(user_id, device_id)
        result = await cache_manager.get(key)
        logger.info(
            f"[CloudDeviceProvider] _get_online_info: user_id={user_id}, "
            f"device_id={device_id}, key={key}, found={result is not None}"
        )
        return result

    async def list_devices(
        self,
        db: Session,
        user_id: int,
        include_offline: bool = True,
    ) -> List[Dict[str, Any]]:
        """List all cloud devices for a user."""
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

        logger.info(
            f"[CloudDeviceProvider] list_devices: user_id={user_id}, "
            f"total_devices={len(devices)}, include_offline={include_offline}"
        )

        result = []
        for device_kind in devices:
            device_json = device_kind.json
            spec = device_json.get("spec", {})
            device_id = device_kind.name

            # Only include cloud devices
            device_type = spec.get("deviceType")
            logger.info(
                f"[CloudDeviceProvider] checking device: device_id={device_id}, "
                f"device_type={device_type}"
            )
            if device_type != DeviceType.CLOUD.value:
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
                    "device_type": DeviceType.CLOUD.value,
                    "connection_mode": DeviceConnectionMode.WEBSOCKET.value,
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
                    "cloud_config": spec.get("cloudConfig"),
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
            return result
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
                        f"[CloudDeviceProvider] Failed to parse task {task.id}: {e}"
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
            return result
        return False

    @staticmethod
    def _is_update_available(current: Optional[str], latest: str) -> bool:
        """Check if update is available using semantic version comparison."""
        if not current:
            return True
        try:
            from packaging import version as pkg_version

            return pkg_version.parse(current) < pkg_version.parse(latest)
        except Exception:
            return False


# Singleton instance
cloud_device_provider = CloudDeviceProvider()
