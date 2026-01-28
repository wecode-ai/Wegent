# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device service for managing local device connections and state.

This service handles:
- Device registration and authentication
- Online state management via Redis
- Heartbeat monitoring
- Task routing to devices
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from shared.models.db.device import Device
from shared.models.db.enums import DeviceStatus

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
        user_id: int, device_id: str, socket_id: str, name: str
    ) -> bool:
        """
        Set device online status in Redis.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier
            socket_id: WebSocket session ID
            name: Device name

        Returns:
            True if set successfully
        """
        key = DeviceService.generate_online_key(user_id, device_id)
        data = {
            "socket_id": socket_id,
            "name": name,
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
        logger.info(
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
    async def get_online_devices(db: Session, user_id: int) -> List[Dict[str, Any]]:
        """
        Get all online devices for a user.

        Queries MySQL for device records and checks Redis for online status.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of online device info dicts
        """
        # Get all devices for user from MySQL
        devices = db.query(Device).filter(Device.user_id == user_id).all()

        online_devices = []
        for device in devices:
            # Check Redis for online status
            online_info = await DeviceService.get_device_online_info(
                user_id, device.device_id
            )
            if online_info:
                online_devices.append(
                    {
                        "device_id": device.device_id,
                        "name": online_info.get("name", device.name),
                        "status": device.status.value if device.status else "online",
                        "last_heartbeat": online_info.get("last_heartbeat"),
                    }
                )

        return online_devices

    @staticmethod
    def register_or_update_device(
        db: Session,
        user_id: int,
        device_id: str,
        name: str,
        status: DeviceStatus = DeviceStatus.ONLINE,
    ) -> Device:
        """
        Register a new device or update existing device record.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier
            name: Device name
            status: Device status

        Returns:
            Device model instance
        """
        device = (
            db.query(Device)
            .filter(Device.user_id == user_id, Device.device_id == device_id)
            .first()
        )

        if device:
            # Update existing device
            device.name = name
            device.status = status
            device.last_heartbeat = datetime.now()
            logger.info(f"Updated device: user_id={user_id}, device_id={device_id}")
        else:
            # Create new device record
            device = Device(
                user_id=user_id,
                device_id=device_id,
                name=name,
                status=status,
                last_heartbeat=datetime.now(),
            )
            db.add(device)
            logger.info(
                f"Registered new device: user_id={user_id}, device_id={device_id}"
            )

        db.commit()
        db.refresh(device)
        return device

    @staticmethod
    def update_device_status(
        db: Session, user_id: int, device_id: str, status: DeviceStatus
    ) -> Optional[Device]:
        """
        Update device status in MySQL.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier
            status: New device status

        Returns:
            Updated device or None if not found
        """
        device = (
            db.query(Device)
            .filter(Device.user_id == user_id, Device.device_id == device_id)
            .first()
        )

        if device:
            device.status = status
            if status == DeviceStatus.ONLINE:
                device.last_heartbeat = datetime.now()
            db.commit()
            db.refresh(device)
            logger.debug(
                f"Updated device status: user_id={user_id}, device_id={device_id}, status={status}"
            )

        return device

    @staticmethod
    def update_device_heartbeat(
        db: Session, user_id: int, device_id: str
    ) -> Optional[Device]:
        """
        Update device heartbeat timestamp in MySQL.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            Updated device or None if not found
        """
        device = (
            db.query(Device)
            .filter(Device.user_id == user_id, Device.device_id == device_id)
            .first()
        )

        if device:
            device.last_heartbeat = datetime.now()
            device.status = DeviceStatus.ONLINE
            db.commit()
            db.refresh(device)

        return device

    @staticmethod
    def mark_device_offline(
        db: Session, user_id: int, device_id: str
    ) -> Optional[Device]:
        """
        Mark a device as offline in MySQL.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            Updated device or None if not found
        """
        return DeviceService.update_device_status(
            db, user_id, device_id, DeviceStatus.OFFLINE
        )


# Singleton instance
device_service = DeviceService()
