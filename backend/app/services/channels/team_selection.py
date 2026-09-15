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

from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.core.config import settings
from app.models.kind import Kind
from app.services.readers.kinds import KindType, kindReader

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

    async def set_selection(self, user_id: int, selection: TeamSelection) -> bool:
        """Set user's team selection in Redis.

        Args:
            user_id: Wegent user ID
            selection: Team selection to save
        """
        key = f"{TEAM_SELECTION_KEY_PREFIX}{user_id}"
        try:
            saved = await cache_manager.set(
                key, json.dumps(selection.to_dict()), expire=TEAM_SELECTION_TTL
            )
            if not saved:
                logger.error(
                    "[TeamSelectionManager] Cache rejected team selection for "
                    "user %s",
                    user_id,
                )
                return False
            logger.info(
                f"[TeamSelectionManager] Saved team selection for user {user_id}: "
                f"{selection.team_name} (id={selection.team_id})"
            )
            return True
        except Exception as e:
            logger.error(
                f"[TeamSelectionManager] Failed to save selection for user {user_id}: {e}"
            )
            return False

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


def get_team_display_name(team: Kind | None) -> str:
    """Return a stable user-facing Team name."""

    if team is None:
        return "未配置"
    team_json = team.json if isinstance(team.json, dict) else {}
    metadata = (
        team_json.get("metadata") if isinstance(team_json.get("metadata"), dict) else {}
    )
    spec = team_json.get("spec") if isinstance(team_json.get("spec"), dict) else {}
    return str(metadata.get("displayName") or spec.get("displayName") or team.name)


async def resolve_selected_team(db: Session, user_id: int) -> Optional[Kind]:
    """Resolve the saved Team selection and revalidate current access."""

    selection = await team_selection_manager.get_selection(user_id)
    if selection is None:
        return None

    from app.services.share.team_share_service import team_share_service

    team = team_share_service.get_resource(db, selection.team_id, user_id)
    if team is not None and (
        team.name != selection.team_name or team.namespace != selection.team_namespace
    ):
        team = None

    if team is not None:
        return team

    logger.warning(
        "[TeamSelectionManager] Selected team is unavailable: user_id=%s, "
        "team_id=%s; clearing selection",
        user_id,
        selection.team_id,
    )
    await team_selection_manager.clear_selection(user_id)
    return None


def resolve_task_mode_team(
    db: Session,
    user_id: int,
    *,
    default_team_id: Optional[int] = None,
) -> Optional[Kind]:
    """Resolve the configured Task-mode Team with channel fallback."""

    config_value = settings.DEFAULT_TEAM_TASK
    if config_value and config_value.strip():
        parts = config_value.strip().split("#", 1)
        name = parts[0].strip()
        namespace = parts[1].strip() if len(parts) > 1 else "default"
        if name:
            team = kindReader.get_by_name_and_namespace(
                db,
                user_id,
                KindType.TEAM,
                namespace,
                name,
            )
            if team is not None:
                return team
            logger.warning(
                "[TeamSelectionManager] Task-mode team is unavailable: "
                "user_id=%s, name=%s, namespace=%s",
                user_id,
                name,
                namespace,
            )

    if not default_team_id:
        return None
    return (
        db.query(Kind)
        .filter(
            Kind.id == default_team_id,
            Kind.kind == KindType.TEAM.value,
            Kind.is_active.is_(True),
        )
        .first()
    )
