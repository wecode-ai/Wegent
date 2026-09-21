# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Team/Agent Selection Manager for IM Channels.

This module provides per-channel team selection management for IM channel
integrations (DingTalk, Feishu, Telegram, etc.). Users can switch between
their available teams/agents dynamically during conversations.

Selections are scoped by (user, channel): switching the agent in one group
chat or bot conversation must not affect other groups or bots. This keeps
the isolation provided by each channel's configured default team intact.

Similar to device_selection and model_selection, but for selecting
which Team (智能体) to use for task execution.
"""

import json
import logging
from dataclasses import asdict, dataclass
from typing import Optional

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

# Redis key prefix for user team selection (scoped per user + channel)
TEAM_SELECTION_KEY_PREFIX = "channel:user_team_selection:"
# TTL for team selection (7 days)
TEAM_SELECTION_TTL = 7 * 24 * 60 * 60


@dataclass
class TeamSelection:
    """User's team/agent selection for IM channel.

    Attributes:
        team_id: Database ID of the selected team
        team_name: Name of the team (Kind.name)
        team_namespace: Namespace of the team (Kind.namespace)
        display_name: Optional display name from spec
    """

    team_id: int
    team_name: str
    team_namespace: str = "default"
    display_name: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "TeamSelection":
        """Create from dictionary."""
        return cls(**data)

    def get_full_name(self) -> str:
        """Get full team identifier with namespace."""
        if self.team_namespace != "default":
            return f"{self.team_namespace}/{self.team_name}"
        return self.team_name


class TeamSelectionManager:
    """Manager for user team selection in IM channels."""

    @staticmethod
    def _key(user_id: int, channel_id: int) -> str:
        """Build the Redis key scoped by user and channel."""
        return f"{TEAM_SELECTION_KEY_PREFIX}{user_id}:{channel_id}"

    async def get_selection(
        self, user_id: int, channel_id: int
    ) -> Optional[TeamSelection]:
        """Get user's current team selection for a channel from Redis.

        Args:
            user_id: Wegent user ID
            channel_id: Channel (bot binding) ID

        Returns:
            TeamSelection if found, None otherwise
        """
        key = self._key(user_id, channel_id)
        data = await cache_manager.get(key)

        if data:
            try:
                if isinstance(data, str):
                    data = json.loads(data)
                return TeamSelection.from_dict(data)
            except (json.JSONDecodeError, TypeError, KeyError) as e:
                logger.warning(
                    f"[TeamSelectionManager] Failed to parse selection for "
                    f"user {user_id}, channel {channel_id}: {e}"
                )
                return None

        return None

    async def set_selection(
        self, user_id: int, channel_id: int, selection: TeamSelection
    ) -> None:
        """Set user's team selection for a channel in Redis.

        Args:
            user_id: Wegent user ID
            channel_id: Channel (bot binding) ID
            selection: Team selection to save
        """
        key = self._key(user_id, channel_id)
        try:
            await cache_manager.set(
                key, json.dumps(selection.to_dict()), expire=TEAM_SELECTION_TTL
            )
            logger.info(
                f"[TeamSelectionManager] Saved team selection for user {user_id}, "
                f"channel {channel_id}: {selection.team_name} (id={selection.team_id})"
            )
        except Exception as e:
            logger.error(
                f"[TeamSelectionManager] Failed to save selection for "
                f"user {user_id}, channel {channel_id}: {e}"
            )

    async def clear_selection(self, user_id: int, channel_id: int) -> None:
        """Clear user's team selection for a channel (revert to default).

        Args:
            user_id: Wegent user ID
            channel_id: Channel (bot binding) ID
        """
        key = self._key(user_id, channel_id)
        await cache_manager.delete(key)
        logger.info(
            f"[TeamSelectionManager] Cleared team selection for "
            f"user {user_id}, channel {channel_id}"
        )


# Global instance
team_selection_manager = TeamSelectionManager()
