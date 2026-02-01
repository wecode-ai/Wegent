# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk User Device Selection Management.

This module manages user device selection for DingTalk channel,
allowing users to route messages to different execution environments:
- Chat Shell (default): Direct LLM conversation
- Local Device: Execute on user's local device (ClaudeCode)
- Cloud Executor: Execute on cloud Docker container
"""

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

# Redis key prefix for user device selection (per user, not per conversation)
DINGTALK_USER_DEVICE_PREFIX = "dingtalk:user_device:"
# TTL for user device selection (30 days)
DINGTALK_USER_DEVICE_TTL = 30 * 24 * 60 * 60


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
    """Manages user device selection for DingTalk channel."""

    @staticmethod
    def _generate_key(user_id: int) -> str:
        """Generate Redis key for user device selection."""
        return f"{DINGTALK_USER_DEVICE_PREFIX}{user_id}"

    @staticmethod
    async def get_selection(user_id: int) -> DeviceSelection:
        """
        Get user's current device selection.

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
            key, selection.to_dict(), expire=DINGTALK_USER_DEVICE_TTL
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
