# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Session Store.

Manages session persistence using Redis for cross-instance session sharing.
Sessions track the mapping between IM conversations and Wegent Tasks.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.core.cache import cache_manager
from app.services.im.base.message import IMPlatform
from app.services.im.base.session import IMSession

logger = logging.getLogger(__name__)

# Redis key prefix for IM sessions
SESSION_KEY_PREFIX = "im:session:"
# Session TTL in seconds (2 hours)
SESSION_TTL = 3600 * 2


class IMSessionStore:
    """
    IM Session Store using Redis.

    Provides session persistence for IM integrations, enabling conversation
    continuity across bot restarts and multiple instances.
    """

    def _get_session_key(
        self,
        platform: IMPlatform,
        platform_user_id: str,
        team_id: int,
    ) -> str:
        """
        Generate Redis key for a session.

        Args:
            platform: IM platform
            platform_user_id: Platform-specific user ID
            team_id: Wegent Team ID

        Returns:
            Redis key string
        """
        return f"{SESSION_KEY_PREFIX}{platform.value}:{team_id}:{platform_user_id}"

    async def get_session(
        self,
        platform: IMPlatform,
        platform_user_id: str,
        team_id: int,
    ) -> Optional[IMSession]:
        """
        Get a session from Redis.

        Args:
            platform: IM platform
            platform_user_id: Platform-specific user ID
            team_id: Wegent Team ID

        Returns:
            Session if found, None otherwise
        """
        key = self._get_session_key(platform, platform_user_id, team_id)
        data = await cache_manager.get(key)
        if data:
            try:
                return IMSession(**data)
            except Exception as e:
                logger.error(f"Failed to deserialize session: {e}")
                return None
        return None

    async def save_session(self, session: IMSession) -> bool:
        """
        Save a session to Redis.

        Args:
            session: Session to save

        Returns:
            True if saved successfully, False otherwise
        """
        key = self._get_session_key(
            session.platform,
            session.platform_user_id,
            session.team_id,
        )
        try:
            # Convert datetime to ISO format for JSON serialization
            data = session.model_dump()
            data["last_activity"] = session.last_activity.isoformat()
            return await cache_manager.set(key, data, expire=SESSION_TTL)
        except Exception as e:
            logger.error(f"Failed to save session: {e}")
            return False

    async def update_session(self, session: IMSession) -> bool:
        """
        Update a session (updates last_activity timestamp).

        Args:
            session: Session to update

        Returns:
            True if updated successfully, False otherwise
        """
        session.last_activity = datetime.now(timezone.utc)
        return await self.save_session(session)

    async def delete_session(
        self,
        platform: IMPlatform,
        platform_user_id: str,
        team_id: int,
    ) -> bool:
        """
        Delete a session from Redis.

        Args:
            platform: IM platform
            platform_user_id: Platform-specific user ID
            team_id: Wegent Team ID

        Returns:
            True if deleted successfully, False otherwise
        """
        key = self._get_session_key(platform, platform_user_id, team_id)
        return await cache_manager.delete(key)

    async def get_or_create_session(
        self,
        platform: IMPlatform,
        platform_user_id: str,
        platform_chat_id: str,
        team_id: int,
        session_timeout_minutes: int = 60,
    ) -> IMSession:
        """
        Get an existing session or create a new one.

        Handles session timeout logic - if the session's last activity is
        older than the timeout, a new session is created.

        Args:
            platform: IM platform
            platform_user_id: Platform-specific user ID
            platform_chat_id: Platform-specific chat ID
            team_id: Wegent Team ID
            session_timeout_minutes: Session timeout in minutes

        Returns:
            Session (existing or newly created)
        """
        session = await self.get_session(platform, platform_user_id, team_id)

        now = datetime.now(timezone.utc)

        if session:
            # Ensure last_activity is timezone-aware for comparison
            last_activity = session.last_activity
            if last_activity.tzinfo is None:
                # Assume UTC for naive datetimes from cache
                last_activity = last_activity.replace(tzinfo=timezone.utc)

            # Check if session has timed out
            timeout_threshold = now - timedelta(minutes=session_timeout_minutes)
            if last_activity < timeout_threshold:
                # Session timed out, create new session
                logger.info(
                    f"Session timeout for {platform.value}:{platform_user_id}, "
                    f"creating new session"
                )
                session = None

        if not session:
            # Create new session
            session = IMSession(
                platform=platform,
                platform_user_id=platform_user_id,
                platform_chat_id=platform_chat_id,
                team_id=team_id,
                task_id=None,
                last_activity=now,
            )
            await self.save_session(session)
            logger.debug(
                f"Created new session for {platform.value}:{platform_user_id}"
            )

        return session


# Global session store instance
im_session_store = IMSessionStore()
