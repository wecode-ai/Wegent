# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Team/Agent Selection Manager for IM Channels.

This module provides user-level team selection management for IM channel
integrations (DingTalk, Feishu, Telegram, etc.). Users can switch between
their available teams/agents dynamically during conversations.

Similar to device_selection and model_selection, but for selecting
which Team (智能体) to use for task execution.
"""

import json
import logging
from dataclasses import asdict, dataclass
from typing import Optional

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)

# Redis key prefix for user team selection
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

    async def get_selection(self, user_id: int) -> Optional[TeamSelection]:
        """Get user's current team selection from Redis.

        Args:
            user_id: Wegent user ID

        Returns:
            TeamSelection if found, None otherwise
        """
        key = f"{TEAM_SELECTION_KEY_PREFIX}{user_id}"
        data = await cache_manager.get(key)

        if data:
            try:
                if isinstance(data, str):
                    data = json.loads(data)
                return TeamSelection.from_dict(data)
            except (json.JSONDecodeError, TypeError, KeyError) as e:
                logger.warning(
                    f"[TeamSelectionManager] Failed to parse selection for user {user_id}: {e}"
                )
                return None

        return None

    async def set_selection(self, user_id: int, selection: TeamSelection) -> None:
        """Set user's team selection in Redis.

        Args:
            user_id: Wegent user ID
            selection: Team selection to save
        """
        key = f"{TEAM_SELECTION_KEY_PREFIX}{user_id}"
        try:
            await cache_manager.set(
                key, json.dumps(selection.to_dict()), expire=TEAM_SELECTION_TTL
            )
            logger.info(
                f"[TeamSelectionManager] Saved team selection for user {user_id}: "
                f"{selection.team_name} (id={selection.team_id})"
            )
        except Exception as e:
            logger.error(
                f"[TeamSelectionManager] Failed to save selection for user {user_id}: {e}"
            )

    async def clear_selection(self, user_id: int) -> None:
        """Clear user's team selection (revert to default).

        Args:
            user_id: Wegent user ID
        """
        key = f"{TEAM_SELECTION_KEY_PREFIX}{user_id}"
        await cache_manager.delete(key)
        logger.info(f"[TeamSelectionManager] Cleared team selection for user {user_id}")


# Global instance
team_selection_manager = TeamSelectionManager()
