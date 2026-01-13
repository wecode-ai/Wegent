# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cached User reader.

Cache Key Design (Data/Index Separation):
    Data:  user:data:{user_id}
    Index: user:idx:name:{user_name} -> user_id

Benefits:
    - Data stored once per user
    - Index stores only user_id
    - Null caching prevents penetration
    - TTL = 300s
"""

import logging
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.user import User
from app.services.readers.users import IUserReader, UserReader
from wecode.cache.base import (
    CACHE_TTL,
    CACHE_VERSION,
    NULL_MARKER,
    dict_to_model,
    get_redis_client,
    model_to_dict,
    register_events,
)

logger = logging.getLogger(__name__)

_events_registered = False


# =============================================================================
# Public API
# =============================================================================


def wrap(base_reader: IUserReader) -> Optional[IUserReader]:
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

    reader = CachedUserReader(redis)

    if not _events_registered:
        register_events(User, _on_change, reader)
        _events_registered = True

    logger.info("User cache loaded")
    return reader


def _on_change(operation: str, target, reader: IUserReader) -> None:
    """Handle model change event."""
    try:
        logger.info(
            f"[user change event] {operation}: {target.user_name} (id={target.id})"
        )
        reader.on_change(
            user_id=target.id,
            user_name=target.user_name,
        )
    except Exception as e:
        logger.warning(f"User change handler error: {e}")


# =============================================================================
# Cached Reader
# =============================================================================


class CachedUserReader(UserReader):
    """Cached User reader using Redis, inherits from UserReader for fallback."""

    def __init__(self, redis):
        self._redis = redis

    # Key generation

    def _key_data(self, user_id: int) -> str:
        return f"user:{CACHE_VERSION}:data:{user_id}"

    def _key_idx_name(self, user_name: str) -> str:
        return f"user:{CACHE_VERSION}:idx:name:{user_name}"

    # Cache operations

    def _get_data(self, user_id: int) -> Optional[dict]:
        try:
            import json

            data = self._redis.get(self._key_data(user_id))
            return json.loads(data) if data else None
        except Exception as e:
            logger.warning(f"Cache get error: {e}")
            return None

    def _get_idx(self, key: str) -> Optional[int]:
        try:
            data = self._redis.get(key)
            if data is None:
                return None
            if isinstance(data, bytes):
                data = data.decode()
            return -1 if data == NULL_MARKER else int(data)
        except Exception as e:
            logger.warning(f"Cache idx error: {e}")
            return None

    def _set_data(self, user_id: int, value: User) -> None:
        try:
            import json

            data = model_to_dict(value)
            self._redis.setex(self._key_data(user_id), CACHE_TTL, json.dumps(data))
        except Exception as e:
            logger.warning(f"Cache set error: {e}")

    def _set_idx(self, key: str, user_id: Optional[int]) -> None:
        try:
            value = NULL_MARKER if user_id is None else str(user_id)
            self._redis.setex(key, CACHE_TTL, value)
        except Exception as e:
            logger.warning(f"Cache idx set error: {e}")

    def _to_model(self, data: dict) -> Optional[User]:
        return dict_to_model(data, User)

    # Query methods

    def get_by_id(self, db: Session, user_id: int) -> Optional[User]:
        cached = self._get_data(user_id)
        if cached is not None:
            return self._to_model(cached)

        result = super().get_by_id(db, user_id)
        if result:
            self._set_data(user_id, result)
        return result

    def get_by_name(self, db: Session, user_name: str) -> Optional[User]:
        idx_key = self._key_idx_name(user_name)

        cached_id = self._get_idx(idx_key)
        if cached_id is not None:
            if cached_id == -1:
                return None
            cached = self._get_data(cached_id)
            if cached is not None:
                return self._to_model(cached)

        result = super().get_by_name(db, user_name)
        if result:
            self._set_data(result.id, result)
            self._set_idx(idx_key, result.id)
        else:
            self._set_idx(idx_key, None)
        return result

    def get_all(self, db: Session) -> List[User]:
        """Get all users (not cached, delegates to parent)."""
        return super().get_all(db)

    # Cache invalidation

    def on_change(self, user_id: int, user_name: str) -> None:
        try:
            keys = [
                self._key_data(user_id),
                self._key_idx_name(user_name),
            ]
            self._redis.delete(*keys)
            logger.debug(f"Invalidated {len(keys)} keys for user {user_name}")
        except Exception as e:
            logger.warning(f"Cache invalidation error: {e}")
