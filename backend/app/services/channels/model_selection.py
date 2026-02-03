# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
User Model Selection Management for IM Channels.

This module manages user model selection for IM channel integrations,
allowing users to select which AI model to use for conversations.

This is channel-agnostic and works across all IM integrations.
"""

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

# Redis key prefix for user model selection (per user, not per conversation)
CHANNEL_USER_MODEL_PREFIX = "channel:user_model:"
# TTL for user model selection (30 days)
CHANNEL_USER_MODEL_TTL = 30 * 24 * 60 * 60


@dataclass
class ModelSelection:
    """User model selection data."""

    model_name: str  # Model name
    model_type: str  # "public", "user", or "group"
    display_name: Optional[str] = None  # Display name for the model
    provider: Optional[str] = None  # Model provider (e.g., "openai", "claude")

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for Redis storage."""
        return {
            "model_name": self.model_name,
            "model_type": self.model_type,
            "display_name": self.display_name,
            "provider": self.provider,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ModelSelection":
        """Create from dictionary (Redis data)."""
        return cls(
            model_name=data.get("model_name", ""),
            model_type=data.get("model_type", "public"),
            display_name=data.get("display_name"),
            provider=data.get("provider"),
        )

    def is_claude_model(self) -> bool:
        """Check if this is a Claude model (required for device mode)."""
        if not self.provider:
            return False
        return self.provider.lower() in ("claude", "anthropic")


class ModelSelectionManager:
    """Manages user model selection for IM channels."""

    @staticmethod
    def _generate_key(user_id: int) -> str:
        """Generate Redis key for user model selection."""
        return f"{CHANNEL_USER_MODEL_PREFIX}{user_id}"

    @staticmethod
    async def get_selection(user_id: int) -> Optional[ModelSelection]:
        """
        Get user's current model selection.

        Args:
            user_id: Wegent user ID

        Returns:
            ModelSelection object or None if not set
        """
        key = ModelSelectionManager._generate_key(user_id)
        data = await cache_manager.get(key)

        if data:
            try:
                return ModelSelection.from_dict(data)
            except Exception as e:
                logger.warning(
                    "[ModelSelection] Failed to parse selection for user %d: %s",
                    user_id,
                    e,
                )

        return None

    @staticmethod
    async def set_selection(user_id: int, selection: ModelSelection) -> bool:
        """
        Set user's model selection.

        Args:
            user_id: Wegent user ID
            selection: ModelSelection to set

        Returns:
            True if set successfully
        """
        key = ModelSelectionManager._generate_key(user_id)
        result = await cache_manager.set(
            key, selection.to_dict(), expire=CHANNEL_USER_MODEL_TTL
        )
        logger.info(
            "[ModelSelection] Set selection for user %d: name=%s, type=%s",
            user_id,
            selection.model_name,
            selection.model_type,
        )
        return result

    @staticmethod
    async def clear_selection(user_id: int) -> bool:
        """
        Clear user's model selection (reset to default).

        Args:
            user_id: Wegent user ID

        Returns:
            True if cleared successfully
        """
        key = ModelSelectionManager._generate_key(user_id)
        result = await cache_manager.delete(key)
        logger.info("[ModelSelection] Cleared selection for user %d", user_id)
        return result


# Singleton instance
model_selection_manager = ModelSelectionManager()


def is_claude_provider(provider: Optional[str]) -> bool:
    """Check if a provider is Claude/Anthropic (required for device mode)."""
    if not provider:
        return False
    return provider.lower() in ("claude", "anthropic")
