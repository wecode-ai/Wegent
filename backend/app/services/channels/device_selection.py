# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
User Device Selection Management for IM Channels.

This module manages user device selection for IM channel integrations,
allowing users to route messages to different execution environments:
- Chat Shell (default): Direct LLM conversation
- Local Device: Execute on user's local device (ClaudeCode)
- Cloud Executor: Execute on cloud Docker container

This is channel-agnostic and works across all IM integrations.

When a user hasn't explicitly selected a device via /use command in IM,
the system will use the user's default_execution_target from their
preferences (set via PC/Web frontend).
"""

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

# Redis key prefix for user device selection (per user, not per conversation)
CHANNEL_USER_DEVICE_PREFIX = "channel:user_device:"
# TTL for user device selection (30 days)
CHANNEL_USER_DEVICE_TTL = 30 * 24 * 60 * 60


class DeviceType(str, Enum):
    """Device execution type."""

    CHAT = "chat"  # Chat Shell mode (default)
    LOCAL = "local"  # Local device execution
    CLOUD = "cloud"  # Cloud executor execution


@dataclass
class DeviceSelection:
    """User device selection data."""

    device_type: DeviceType
    device_id: Optional[str] = None  # Only set for LOCAL type
    device_name: Optional[str] = None  # Display name for LOCAL type

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for Redis storage."""
        return {
            "device_type": self.device_type.value,
            "device_id": self.device_id,
            "device_name": self.device_name,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DeviceSelection":
        """Create from dictionary (Redis data)."""
        return cls(
            device_type=DeviceType(data.get("device_type", DeviceType.CHAT.value)),
            device_id=data.get("device_id"),
            device_name=data.get("device_name"),
        )

    @classmethod
    def default(cls) -> "DeviceSelection":
        """Create default selection (Chat Shell mode)."""
        return cls(device_type=DeviceType.CHAT)


class DeviceSelectionManager:
    """Manages user device selection for IM channels."""

    @staticmethod
    def _generate_key(user_id: int) -> str:
        """Generate Redis key for user device selection."""
        return f"{CHANNEL_USER_DEVICE_PREFIX}{user_id}"

    @staticmethod
    async def get_selection_from_user_preference(
        user_id: int,
    ) -> Optional[DeviceSelection]:
        """
        Get device selection from user's default_execution_target preference.

        This is used when there's no explicit IM device selection in Redis.
        The user's preference is set via PC/Web frontend.

        Args:
            user_id: Wegent user ID

        Returns:
            DeviceSelection based on user preference, or None if not set
        """
        from app.db.session import SessionLocal
        from app.models.user import User

        db = SessionLocal()
        try:
            user = db.query(User).filter(User.id == user_id).first()
            if not user or not user.preferences:
                return None

            default_target = user.preferences.get("default_execution_target")
            if not default_target:
                return None

            # 'cloud' means cloud executor mode
            if default_target == "cloud":
                logger.info(
                    "[DeviceSelection] Using user preference for user %d: cloud mode",
                    user_id,
                )
                return DeviceSelection(device_type=DeviceType.CLOUD)

            # Otherwise it's a device_id for local device
            # We need to get the device name from device service
            from app.services.device_service import device_service

            device_info = await device_service.get_device_online_info(
                user_id, default_target
            )
            if device_info:
                logger.info(
                    "[DeviceSelection] Using user preference for user %d: "
                    "local device %s (%s)",
                    user_id,
                    default_target,
                    device_info.get("name", "Unknown"),
                )
                return DeviceSelection(
                    device_type=DeviceType.LOCAL,
                    device_id=default_target,
                    device_name=device_info.get("name"),
                )
            else:
                # Device is offline or not found, fall back to default
                logger.info(
                    "[DeviceSelection] User preference device %s is offline/not found "
                    "for user %d, falling back to default",
                    default_target,
                    user_id,
                )
                return None
        except Exception as e:
            logger.warning(
                "[DeviceSelection] Failed to get user preference for user %d: %s",
                user_id,
                e,
            )
            return None
        finally:
            db.close()

    @staticmethod
    async def get_selection(user_id: int) -> DeviceSelection:
        """
        Get user's current device selection.

        Priority:
        1. Explicit IM selection from Redis (set via /use command)
        2. User's default_execution_target preference (set via PC/Web)
        3. Default to Chat mode

        Args:
            user_id: Wegent user ID

        Returns:
            DeviceSelection object (defaults to Chat mode if not set)
        """
        key = DeviceSelectionManager._generate_key(user_id)
        data = await cache_manager.get(key)

        if data:
            try:
                return DeviceSelection.from_dict(data)
            except Exception as e:
                logger.warning(
                    "[DeviceSelection] Failed to parse selection for user %d: %s",
                    user_id,
                    e,
                )

        # No explicit IM selection, try user's default preference
        preference_selection = (
            await DeviceSelectionManager.get_selection_from_user_preference(user_id)
        )
        if preference_selection:
            return preference_selection

        return DeviceSelection.default()

    @staticmethod
    async def set_selection(user_id: int, selection: DeviceSelection) -> bool:
        """
        Set user's device selection.

        Args:
            user_id: Wegent user ID
            selection: DeviceSelection to set

        Returns:
            True if set successfully
        """
        key = DeviceSelectionManager._generate_key(user_id)
        result = await cache_manager.set(
            key, selection.to_dict(), expire=CHANNEL_USER_DEVICE_TTL
        )
        logger.info(
            "[DeviceSelection] Set selection for user %d: type=%s, device_id=%s",
            user_id,
            selection.device_type.value,
            selection.device_id,
        )
        return result

    @staticmethod
    async def clear_selection(user_id: int) -> bool:
        """
        Clear user's device selection (reset to Chat mode).

        Args:
            user_id: Wegent user ID

        Returns:
            True if cleared successfully
        """
        key = DeviceSelectionManager._generate_key(user_id)
        result = await cache_manager.delete(key)
        logger.info("[DeviceSelection] Cleared selection for user %d", user_id)
        return result

    @staticmethod
    async def set_local_device(user_id: int, device_id: str, device_name: str) -> bool:
        """
        Set user to use local device.

        Args:
            user_id: Wegent user ID
            device_id: Local device ID
            device_name: Device display name

        Returns:
            True if set successfully
        """
        selection = DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id=device_id,
            device_name=device_name,
        )
        return await DeviceSelectionManager.set_selection(user_id, selection)

    @staticmethod
    async def set_cloud_executor(user_id: int) -> bool:
        """
        Set user to use cloud executor.

        Args:
            user_id: Wegent user ID

        Returns:
            True if set successfully
        """
        selection = DeviceSelection(device_type=DeviceType.CLOUD)
        return await DeviceSelectionManager.set_selection(user_id, selection)

    @staticmethod
    async def set_chat_mode(user_id: int) -> bool:
        """
        Set user to use chat mode (clear device selection).

        Args:
            user_id: Wegent user ID

        Returns:
            True if set successfully
        """
        return await DeviceSelectionManager.clear_selection(user_id)


# Singleton instance
device_selection_manager = DeviceSelectionManager()
