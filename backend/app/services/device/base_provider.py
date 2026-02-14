# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base device provider abstract class.

Defines the interface that all device providers must implement.
Uses the Strategy pattern to allow different device types (local, cloud)
to have their own implementation while sharing a common interface.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.schemas.device import DeviceType


class BaseDeviceProvider(ABC):
    """Abstract base class for device providers.

    All device providers (LocalDeviceProvider, future CloudDeviceProvider, etc.)
    must implement this interface to ensure consistent behavior across
    different device types.

    The provider pattern allows:
    - Easy addition of new device types without modifying existing code
    - Clear separation of concerns between device types
    - Consistent API for the DeviceService to interact with
    """

    @property
    @abstractmethod
    def device_type(self) -> DeviceType:
        """Return the device type this provider handles.

        Returns:
            DeviceType enum value
        """
        pass

    @abstractmethod
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
        """Register a device.

        Creates or updates the device record in the database and sets up
        any necessary state (e.g., Redis online status for WebSocket devices).

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier
            name: Device display name
            socket_id: WebSocket session ID (for WebSocket-connected devices)
            executor_version: Executor version string
            capabilities: List of capability tags
            client_ip: Device's client IP address

        Returns:
            Dict containing device info including 'id' and 'is_default'
        """
        pass

    @abstractmethod
    async def unregister(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> bool:
        """Unregister a device (set offline status, cleanup).

        Does not delete the device record, just marks it as offline
        and cleans up any runtime state.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            True if successful
        """
        pass

    @abstractmethod
    async def get_status(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Get device status and information.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            Device status dict or None if not found
        """
        pass

    @abstractmethod
    async def list_devices(
        self,
        db: Session,
        user_id: int,
        include_offline: bool = True,
    ) -> List[Dict[str, Any]]:
        """List all devices of this type for a user.

        Args:
            db: Database session
            user_id: User ID
            include_offline: Whether to include offline devices

        Returns:
            List of device info dicts
        """
        pass

    @abstractmethod
    async def refresh_heartbeat(
        self,
        user_id: int,
        device_id: str,
        running_task_ids: Optional[List[int]] = None,
        executor_version: Optional[str] = None,
    ) -> bool:
        """Refresh device heartbeat (extend TTL, update running tasks).

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier
            running_task_ids: List of currently running task IDs
            executor_version: Executor version string

        Returns:
            True if successful
        """
        pass

    @abstractmethod
    async def is_online(
        self,
        user_id: int,
        device_id: str,
    ) -> bool:
        """Check if device is online.

        Args:
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            True if device is online
        """
        pass

    @abstractmethod
    async def get_slot_usage(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> Dict[str, Any]:
        """Get device slot usage information.

        Args:
            db: Database session
            user_id: User ID
            device_id: Device unique identifier

        Returns:
            Dict with 'used', 'max', and 'running_tasks' keys
        """
        pass

    async def delete(
        self,
        db: Session,
        user_id: int,
        device_id: str,
    ) -> bool:
        """Delete a device (soft delete).

        Default implementation marks the device as inactive in the database.
        Subclasses can override for custom cleanup behavior.

        Args:
            db: Database session
            user_id: Device owner user ID
            device_id: Device unique identifier

        Returns:
            True if device was found and deleted
        """
        from sqlalchemy import and_

        from app.models.kind import Kind

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
            return True

        return False
