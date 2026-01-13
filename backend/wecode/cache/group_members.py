# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cached GroupMember reader.

Cache Key Design:
    Index: group_member:idx:group_user:{group_name}:{user_id} -> role or NULL_MARKER
    List:  group_member:idx:user_groups:{user_id} -> [group_name, ...]

Benefits:
    - Fast lookup for membership check
    - Null caching prevents penetration
    - TTL = 300s
"""

import logging
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.namespace_member import NamespaceMember
from app.services.readers.group_members import IGroupMemberReader
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


def wrap(base_reader: IGroupMemberReader) -> Optional[IGroupMemberReader]:
    """
    Wrap base reader with Redis caching.

    Args:
        base_reader: The underlying reader

    Returns:
        Cached reader if Redis available, None otherwise
    """
    global _events_registered

    redis = get_redis_client()
    if redis is None:
        return None

    reader = CachedGroupMemberReader(base_reader, redis)

    if not _events_registered:
        register_events(NamespaceMember, _on_change, reader)
        _events_registered = True

    logger.info("GroupMember cache loaded")
    return reader


def _on_change(operation: str, target, reader: IGroupMemberReader) -> None:
    """Handle model change event."""
    try:
        logger.info(
            f"[group_member change event] {operation}: group={target.group_name}, user={target.user_id}"
        )
        reader.on_change(
            group_name=target.group_name,
            user_id=target.user_id,
        )
    except Exception as e:
        logger.warning(f"GroupMember change handler error: {e}")


# =============================================================================
# Cached Reader
# =============================================================================


class CachedGroupMemberReader(IGroupMemberReader):
    """Cached GroupMember reader using Redis."""

    def __init__(self, base: IGroupMemberReader, redis):
        self._base = base
        self._redis = redis

    # Key generation

    def _key_idx_group_user(self, group_name: str, user_id: int) -> str:
        return f"group_member:{CACHE_VERSION}:idx:group_user:{group_name}:{user_id}"

    def _key_idx_user_groups(self, user_id: int) -> str:
        return f"group_member:{CACHE_VERSION}:idx:user_groups:{user_id}"

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

    def _get_list(self, key: str) -> Optional[List[str]]:
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

    def _set_list(self, key: str, value: List[str]) -> None:
        try:
            import json

            if not value:
                self._redis.setex(key, CACHE_TTL, NULL_MARKER)
            else:
                self._redis.setex(key, CACHE_TTL, json.dumps(value))
        except Exception as e:
            logger.warning(f"Cache set list error: {e}")

    # Query methods

    def is_member(self, db: Session, group_name: str, user_id: int) -> bool:
        role = self.get_role(db, group_name, user_id)
        return role is not None

    def get_role(self, db: Session, group_name: str, user_id: int) -> Optional[str]:
        idx_key = self._key_idx_group_user(group_name, user_id)

        cached = self._get_idx(idx_key)
        if cached is not None:
            return None if cached == NULL_MARKER else cached

        result = self._base.get_role(db, group_name, user_id)
        self._set_idx(idx_key, result if result else NULL_MARKER)
        return result

    def get_by_group_and_user(
        self, db: Session, group_name: str, user_id: int
    ) -> Optional[NamespaceMember]:
        # Not cached, delegates to base reader
        return self._base.get_by_group_and_user(db, group_name, user_id)

    def get_user_groups(self, db: Session, user_id: int) -> List[str]:
        list_key = self._key_idx_user_groups(user_id)

        cached = self._get_list(list_key)
        if cached is not None:
            return cached

        result = self._base.get_user_groups(db, user_id)
        self._set_list(list_key, result)
        return result

    # Cache invalidation

    def on_change(self, group_name: str, user_id: int) -> None:
        try:
            keys = [
                self._key_idx_group_user(group_name, user_id),
                self._key_idx_user_groups(user_id),
            ]
            self._redis.delete(*keys)
            logger.debug(
                f"Invalidated {len(keys)} keys for group_member group={group_name}, user={user_id}"
            )
        except Exception as e:
            logger.warning(f"Cache invalidation error: {e}")
