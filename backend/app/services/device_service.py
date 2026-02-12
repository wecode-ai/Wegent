# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device service for managing local device connections and state.

This service handles:
- Device registration and authentication via Kind CRD
- Online state management via Redis
- Heartbeat monitoring
- Task routing to devices
- Version management and update checking

The service delegates device-type-specific operations to providers
via the DeviceProviderFactory, allowing for extensibility to support
different device types (local, cloud, etc.) in the future.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceType

logger = logging.getLogger(__name__)


class DeviceService:
    """Service for managing device connections and state.

    This service acts as a facade over device providers, delegating
    operations to the appropriate provider based on device type.

    For backward compatibility, methods without explicit device_type
    parameter default to LOCAL device type.
    """

    @staticmethod
    def _get_provider(device_type: DeviceType = DeviceType.LOCAL):
        """Get the provider for a device type."""
        from app.services.device.provider_factory import DeviceProviderFactory

        provider = DeviceProviderFactory.get_provider(device_type)
        if provider is None:
            raise ValueError(f"No provider registered for device type: {device_type}")
        return provider

    @staticmethod
    def generate_online_key(user_id: int, device_id: str) -> str:
        """Generate Redis key for device online status.

        Maintained for backward compatibility with existing code.
        """
        from app.services.device.local_provider import LocalDeviceProvider

        return LocalDeviceProvider.generate_online_key(user_id, device_id)

    @staticmethod
    async def set_device_online(
        user_id: int,
        device_id: str,
        socket_id: str,
        name: str,
        status: str = "online",
        executor_version: Optional[str] = None,
    ) -> bool:
        """Set device online status in Redis.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier
            socket_id: WebSocket session ID
            name: Device name
            status: Device status (online, busy)
            executor_version: Executor version (e.g., '1.0.0')

        Returns:
            True if set successfully
        """
        provider = DeviceService._get_provider(DeviceType.LOCAL)
        return await provider._set_online(
            user_id=user_id,
            device_id=device_id,
            socket_id=socket_id,
            name=name,
            status=status,
            executor_version=executor_version,
        )

    @staticmethod
    async def refresh_device_heartbeat(
        user_id: int,
        device_id: str,
        running_task_ids: list[int] = None,
        executor_version: Optional[str] = None,
    ) -> bool:
        """Refresh device heartbeat in Redis (extend TTL) and update running task IDs.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier
            running_task_ids: List of task IDs currently running on this device
            executor_version: Executor version (e.g., '1.0.0')

        Returns:
            True if refreshed successfully
        """
        provider = DeviceService._get_provider(DeviceType.LOCAL)
        return await provider.refresh_heartbeat(
            user_id=user_id,
            device_id=device_id,
            running_task_ids=running_task_ids,
            executor_version=executor_version,
        )

    @staticmethod
    async def set_device_offline(user_id: int, device_id: str) -> bool:
        """Remove device online status from Redis.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            True if deleted successfully
        """
        provider = DeviceService._get_provider(DeviceType.LOCAL)
        return await provider.unregister(db=None, user_id=user_id, device_id=device_id)

    @staticmethod
    async def update_device_status_in_redis(
        user_id: int, device_id: str, status: str
    ) -> bool:
        """Update device status in Redis.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier
            status: New status (online, busy)

        Returns:
            True if updated successfully
        """
        provider = DeviceService._get_provider(DeviceType.LOCAL)
        return await provider.update_status(
            user_id=user_id,
            device_id=device_id,
            status=status,
        )

    @staticmethod
    async def get_device_online_info(
        user_id: int, device_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get device online information from Redis.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            Device online info dict or None if offline
        """
        provider = DeviceService._get_provider(DeviceType.LOCAL)
        return await provider._get_online_info(user_id, device_id)

    @staticmethod
    async def is_device_online(user_id: int, device_id: str) -> bool:
        """Check if device is online.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            True if device is online
        """
        provider = DeviceService._get_provider(DeviceType.LOCAL)
        return await provider.is_online(user_id, device_id)

    @staticmethod
    async def get_device_slot_usage_async(
        db: Session, user_id: int, device_id: str
    ) -> Dict[str, Any]:
        """Get slot usage information for a device (async version).

        Args:
            db: Database session
            user_id: User ID (for Redis key)
            device_id: Device unique identifier

        Returns:
            Dict with slot usage info: {"used": int, "max": int, "running_tasks": list}
        """
        provider = DeviceService._get_provider(DeviceType.LOCAL)
        return await provider.get_slot_usage(db, user_id, device_id)

    @staticmethod
    def is_update_available(current: Optional[str], latest: str) -> bool:
        """Check if update is available using semantic version comparison.

        Args:
            current: Current executor version (e.g., '1.0.0'), None for old executors
            latest: Latest available version (e.g., '1.1.0')

        Returns:
            True if update is available (current < latest or current is None)
        """
        from app.services.device.local_provider import LocalDeviceProvider

        return LocalDeviceProvider._is_update_available(current, latest)

    @staticmethod
    async def get_all_devices(db: Session, user_id: int) -> List[Dict[str, Any]]:
        """Get all devices for a user (both online and offline).

        Queries kinds table for Device CRDs and enriches with Redis online status.
        Currently only returns local devices. Future versions may aggregate
        devices from multiple providers.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of device info dicts
        """
        provider = DeviceService._get_provider(DeviceType.LOCAL)
        return await provider.list_devices(db, user_id, include_offline=True)

    @staticmethod
    async def get_online_devices(db: Session, user_id: int) -> List[Dict[str, Any]]:
        """Get only online devices for a user.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of online device info dicts
        """
        provider = DeviceService._get_provider(DeviceType.LOCAL)
        return await provider.list_devices(db, user_id, include_offline=False)

    @staticmethod
    def upsert_device_crd(
        db: Session,
        user_id: int,
        device_id: str,
        name: str,
    ) -> Kind:
        """Create or update a Device CRD record.

        Called during WebSocket device registration.
        The device_id is stored in Kind.name field for faster queries.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier (stored in Kind.name)
            name: Device display name (stored in spec.displayName)

        Returns:
            Kind model instance for the device
        """
        # Find device by Kind.name (which stores device_id), including soft-deleted
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

        if device_kind:
            # Update existing device (reactivate if soft-deleted)
            device_json = device_kind.json.copy()
            device_json["spec"]["displayName"] = name
            # Ensure device type fields are set for backward compatibility
            if "deviceType" not in device_json["spec"]:
                device_json["spec"]["deviceType"] = DeviceType.LOCAL.value
            if "connectionMode" not in device_json["spec"]:
                device_json["spec"]["connectionMode"] = "websocket"
            device_kind.json = device_json
            device_kind.updated_at = datetime.now()
            device_kind.is_active = True
            db.add(device_kind)
            logger.info(f"Updated device CRD: user_id={user_id}, device_id={device_id}")
        else:
            # Check if this is the first device for the user
            existing_device_count = (
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
            is_first_device = existing_device_count == 0

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
                    "connectionMode": "websocket",
                    "isDefault": is_first_device,
                    "capabilities": None,
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
                f"Registered new device CRD: user_id={user_id}, device_id={device_id}, "
                f"is_default={is_first_device}"
            )

        db.commit()
        db.refresh(device_kind)
        return device_kind

    @staticmethod
    def set_device_as_default(
        db: Session,
        user_id: int,
        device_id: str,
    ) -> bool:
        """Set a device as the default for the user.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier (stored in Kind.name)

        Returns:
            True if device was found and set as default
        """
        # Get all Device CRDs for this user
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

        found = False
        for device_kind in devices:
            device_json = device_kind.json.copy()

            if device_kind.name == device_id:
                device_json["spec"]["isDefault"] = True
                found = True
            else:
                device_json["spec"]["isDefault"] = False

            device_kind.json = device_json
            db.add(device_kind)

        if found:
            db.commit()
            logger.info(
                f"Set device as default: user_id={user_id}, device_id={device_id}"
            )

        return found

    @staticmethod
    def delete_device(
        db: Session,
        user_id: int,
        device_id: str,
    ) -> bool:
        """Delete a device CRD (soft delete).

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier (stored in Kind.name)

        Returns:
            True if device was found and deleted
        """
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
            device_kind.is_active = False
            db.commit()
            logger.info(f"Deleted device CRD: user_id={user_id}, device_id={device_id}")
            return True

        return False

    @staticmethod
    def get_device_by_device_id(
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Optional[Kind]:
        """Get a device CRD by device_id.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier (stored in Kind.name)

        Returns:
            Kind model instance or None if not found
        """
        return (
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


# Singleton instance
device_service = DeviceService()
