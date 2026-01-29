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
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.kind import Kind

logger = logging.getLogger(__name__)

# Redis key patterns
DEVICE_ONLINE_KEY_PREFIX = "device:online:"
DEVICE_ONLINE_TTL = 90  # seconds (heartbeat interval 30s x 3)


class DeviceService:
    """Service for managing local device connections and state."""

    @staticmethod
    def generate_online_key(user_id: int, device_id: str) -> str:
        """Generate Redis key for device online status."""
        return f"{DEVICE_ONLINE_KEY_PREFIX}{user_id}:{device_id}"

    @staticmethod
    async def set_device_online(
        user_id: int, device_id: str, socket_id: str, name: str, status: str = "online"
    ) -> bool:
        """
        Set device online status in Redis.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier
            socket_id: WebSocket session ID
            name: Device name
            status: Device status (online, busy)

        Returns:
            True if set successfully
        """
        key = DeviceService.generate_online_key(user_id, device_id)
        data = {
            "socket_id": socket_id,
            "name": name,
            "status": status,
            "last_heartbeat": datetime.now().isoformat(),
        }
        result = await cache_manager.set(key, data, expire=DEVICE_ONLINE_TTL)
        logger.info(f"[DeviceService] set_device_online: key={key}, result={result}")
        return result

    @staticmethod
    async def refresh_device_heartbeat(user_id: int, device_id: str) -> bool:
        """
        Refresh device heartbeat in Redis (extend TTL).

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            True if refreshed successfully
        """
        key = DeviceService.generate_online_key(user_id, device_id)
        data = await cache_manager.get(key)
        if data:
            data["last_heartbeat"] = datetime.now().isoformat()
            result = await cache_manager.set(key, data, expire=DEVICE_ONLINE_TTL)
            logger.debug(
                f"[DeviceService] refresh_device_heartbeat: key={key}, result={result}"
            )
            return result
        logger.warning(
            f"[DeviceService] refresh_device_heartbeat: key={key} not found in Redis"
        )
        return False

    @staticmethod
    async def set_device_offline(user_id: int, device_id: str) -> bool:
        """
        Remove device online status from Redis.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            True if deleted successfully
        """
        key = DeviceService.generate_online_key(user_id, device_id)
        return await cache_manager.delete(key)

    @staticmethod
    async def update_device_status_in_redis(
        user_id: int, device_id: str, status: str
    ) -> bool:
        """
        Update device status in Redis.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier
            status: New status (online, busy)

        Returns:
            True if updated successfully
        """
        key = DeviceService.generate_online_key(user_id, device_id)
        data = await cache_manager.get(key)
        if data:
            data["status"] = status
            data["last_heartbeat"] = datetime.now().isoformat()
            result = await cache_manager.set(key, data, expire=DEVICE_ONLINE_TTL)
            logger.debug(
                f"[DeviceService] update_device_status_in_redis: key={key}, status={status}"
            )
            return result
        return False

    @staticmethod
    async def get_device_online_info(
        user_id: int, device_id: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get device online information from Redis.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            Device online info dict or None if offline
        """
        key = DeviceService.generate_online_key(user_id, device_id)
        result = await cache_manager.get(key)
        logger.debug(
            f"[DeviceService] get_device_online_info: key={key}, found={result is not None}"
        )
        return result

    @staticmethod
    async def is_device_online(user_id: int, device_id: str) -> bool:
        """
        Check if device is online.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            True if device is online
        """
        info = await DeviceService.get_device_online_info(user_id, device_id)
        return info is not None

    @staticmethod
    async def get_all_devices(db: Session, user_id: int) -> List[Dict[str, Any]]:
        """
        Get all devices for a user (both online and offline).

        Queries kinds table for Device CRDs and enriches with Redis online status.
        Device ID is stored in Kind.name field.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of device info dicts
        """
        # Get all Device CRDs for user from kinds table
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
            # device_id is stored in Kind.name field
            device_id = device_kind.name

            # Get online status from Redis
            online_info = await DeviceService.get_device_online_info(user_id, device_id)

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
                    "last_heartbeat": (
                        online_info.get("last_heartbeat") if online_info else None
                    ),
                    "capabilities": spec.get("capabilities"),
                }
            )

        return result

    @staticmethod
    async def get_online_devices(db: Session, user_id: int) -> List[Dict[str, Any]]:
        """
        Get only online devices for a user.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of online device info dicts
        """
        all_devices = await DeviceService.get_all_devices(db, user_id)
        return [d for d in all_devices if d["status"] != "offline"]

    @staticmethod
    def upsert_device_crd(
        db: Session,
        user_id: int,
        device_id: str,
        name: str,
    ) -> Kind:
        """
        Create or update a Device CRD record.
        Called during WebSocket device registration.

        The device_id is stored in Kind.name field for faster queries.
        The display name is stored in json.spec.displayName.
        First device registered becomes the default device automatically.

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
                    Kind.name == device_id,  # device_id stored in name field
                )
            )
            .first()
        )

        if device_kind:
            # Update existing device (reactivate if soft-deleted)
            device_json = device_kind.json.copy()
            device_json["spec"]["displayName"] = name
            device_kind.json = device_json
            device_kind.updated_at = datetime.now()
            device_kind.is_active = True  # Reactivate if was soft-deleted
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
                    "isDefault": is_first_device,  # First device is default
                    "capabilities": None,
                },
                "status": {
                    "state": "Available",
                },
            }

            device_kind = Kind(
                user_id=user_id,
                kind="Device",
                name=device_id,  # Store device_id in name field for faster queries
                namespace="default",
                json=device_json,
            )
            db.add(device_kind)
            logger.info(
                f"Registered new device CRD: user_id={user_id}, device_id={device_id}, is_default={is_first_device}"
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
        """
        Set a device as the default for the user.

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

            # device_id is stored in Kind.name field
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
        """
        Delete a device CRD (soft delete).

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier (stored in Kind.name)

        Returns:
            True if device was found and deleted
        """
        # Find the device by Kind.name (which stores device_id)
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
        """
        Get a device CRD by device_id.

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
