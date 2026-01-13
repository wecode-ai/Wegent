# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cached SharedTeam reader.

Cache Key Design:
    Index: shared_team:idx:team_user:{team_id}:{user_id} -> 1 or NULL_MARKER
    List:  shared_team:idx:user_teams:{user_id} -> [team_id, ...]

Benefits:
    - Fast lookup for team sharing check
    - Null caching prevents penetration
    - TTL = 300s
"""

import logging
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.shared_team import SharedTeam
from app.services.readers.shared_teams import ISharedTeamReader, SharedTeamReader
from wecode.cache.base import (
    CACHE_TTL,
    CACHE_VERSION,
    NULL_MARKER,
    get_redis_client,
    register_events,
)

logger = logging.getLogger(__name__)

_events_registered = False


# =============================================================================
# Public API
# =============================================================================


def wrap(base_reader: ISharedTeamReader) -> Optional[ISharedTeamReader]:
    """
    Create cached reader with Redis caching.

    Args:
        base_reader: The underlying reader (kept for API compatibility, not used)

    Returns:
        Cached reader if Redis available, None otherwise
    """
    global _events_registered

    redis = get_redis_client()
    if redis is None:
        return None

    reader = CachedSharedTeamReader(redis)

    if not _events_registered:
        register_events(SharedTeam, _on_change, reader)
        _events_registered = True

    logger.info("SharedTeam cache loaded")
    return reader


def _on_change(operation: str, target, reader: ISharedTeamReader) -> None:
    """Handle model change event."""
    try:
        logger.info(
            f"[shared_team change event] {operation}: team_id={target.team_id}, user_id={target.user_id}"
        )
        reader.on_change(
            team_id=target.team_id,
            user_id=target.user_id,
        )
    except Exception as e:
        logger.warning(f"SharedTeam change handler error: {e}")


# =============================================================================
# Cached Reader
# =============================================================================


class CachedSharedTeamReader(SharedTeamReader):
    """Cached SharedTeam reader using Redis, inherits from SharedTeamReader for fallback."""

    def __init__(self, redis):
        self._redis = redis

    # Key generation

    def _key_idx_team_user(self, team_id: int, user_id: int) -> str:
        return f"shared_team:{CACHE_VERSION}:idx:team_user:{team_id}:{user_id}"

    def _key_idx_user_teams(self, user_id: int) -> str:
        return f"shared_team:{CACHE_VERSION}:idx:user_teams:{user_id}"

    # Cache operations

    def _get_idx(self, key: str) -> Optional[str]:
        try:
            data = self._redis.get(key)
            if data is None:
                return None
            if isinstance(data, bytes):
                data = data.decode()
            return data
        except Exception as e:
            logger.warning(f"Cache get error: {e}")
            return None

    def _set_idx(self, key: str, value: str) -> None:
        try:
            self._redis.setex(key, CACHE_TTL, value)
        except Exception as e:
            logger.warning(f"Cache set error: {e}")

    def _get_list(self, key: str) -> Optional[List[int]]:
        try:
            import json

            data = self._redis.get(key)
            if data is None:
                return None
            if isinstance(data, bytes):
                data = data.decode()
            if data == NULL_MARKER:
                return []
            return json.loads(data)
        except Exception as e:
            logger.warning(f"Cache get list error: {e}")
            return None

    def _set_list(self, key: str, value: List[int]) -> None:
        try:
            import json

            if not value:
                self._redis.setex(key, CACHE_TTL, NULL_MARKER)
            else:
                self._redis.setex(key, CACHE_TTL, json.dumps(value))
        except Exception as e:
            logger.warning(f"Cache set list error: {e}")

    # Query methods

    def is_shared_to_user(self, db: Session, team_id: int, user_id: int) -> bool:
        idx_key = self._key_idx_team_user(team_id, user_id)

        cached = self._get_idx(idx_key)
        if cached is not None:
            return cached != NULL_MARKER

        result = super().is_shared_to_user(db, team_id, user_id)
        self._set_idx(idx_key, "1" if result else NULL_MARKER)
        return result

    def get_shared_team_ids(self, db: Session, user_id: int) -> List[int]:
        list_key = self._key_idx_user_teams(user_id)

        cached = self._get_list(list_key)
        if cached is not None:
            return cached

        result = super().get_shared_team_ids(db, user_id)
        self._set_list(list_key, result)
        return result

    def get_by_team_and_user(
        self, db: Session, team_id: int, user_id: int
    ) -> Optional[SharedTeam]:
        # Not cached, delegates to parent
        return super().get_by_team_and_user(db, team_id, user_id)

    # Cache invalidation

    def on_change(self, team_id: int, user_id: int) -> None:
        try:
            keys = [
                self._key_idx_team_user(team_id, user_id),
                self._key_idx_user_teams(user_id),
            ]
            self._redis.delete(*keys)
            logger.debug(
                f"Invalidated {len(keys)} keys for shared_team team={team_id}, user={user_id}"
            )
        except Exception as e:
            logger.warning(f"Cache invalidation error: {e}")
