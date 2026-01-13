# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cached Group reader.

Cache Key Design:
    Data:  group:data:{name} -> {name, visibility, owner_user_id, ...}

Benefits:
    - Fast lookup for group visibility check
    - Null caching prevents penetration
    - TTL = 300s
"""

import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.services.readers.groups import VISIBILITY_PUBLIC, IGroupReader
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


def wrap(base_reader: IGroupReader) -> Optional[IGroupReader]:
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

    reader = CachedGroupReader(base_reader, redis)

    if not _events_registered:
        register_events(Namespace, _on_change, reader)
        _events_registered = True

    logger.info("Group cache loaded")
    return reader


def _on_change(operation: str, target, reader: IGroupReader) -> None:
    """Handle model change event."""
    try:
        logger.info(f"[group change event] {operation}: {target.name}")
        reader.on_change(name=target.name)
    except Exception as e:
        logger.warning(f"Group change handler error: {e}")


# =============================================================================
# Cached Reader
# =============================================================================


class CachedGroupReader(IGroupReader):
    """Cached Group reader using Redis."""

    def __init__(self, base: IGroupReader, redis):
        self._base = base
        self._redis = redis

    # Key generation

    def _key_data(self, name: str) -> str:
        return f"group:{CACHE_VERSION}:data:{name}"

    # Cache operations

    def _get_data(self, name: str) -> Optional[dict]:
        try:
            import json

            data = self._redis.get(self._key_data(name))
            if data is None:
                return None
            if isinstance(data, bytes):
                data = data.decode()
            if data == NULL_MARKER:
                return {"_null": True}
            return json.loads(data)
        except Exception as e:
            logger.warning(f"Cache get error: {e}")
            return None

    def _set_data(self, name: str, value: Optional[Namespace]) -> None:
        try:
            import json

            key = self._key_data(name)
            if value is None:
                self._redis.setex(key, CACHE_TTL, NULL_MARKER)
            else:
                data = model_to_dict(value)
                self._redis.setex(key, CACHE_TTL, json.dumps(data))
        except Exception as e:
            logger.warning(f"Cache set error: {e}")

    def _to_model(self, data: dict) -> Optional[Namespace]:
        if not data or data.get("_null"):
            return None
        return dict_to_model(data, Namespace)

    # Query methods

    def get_by_name(self, db: Session, name: str) -> Optional[Namespace]:
        cached = self._get_data(name)
        if cached is not None:
            return self._to_model(cached)

        result = self._base.get_by_name(db, name)
        self._set_data(name, result)
        return result

    def get_visibility(self, db: Session, name: str) -> Optional[str]:
        cached = self._get_data(name)
        if cached is not None:
            if cached.get("_null"):
                return None
            return cached.get("visibility")

        group = self._base.get_by_name(db, name)
        self._set_data(name, group)
        return group.visibility if group else None

    def is_public(self, db: Session, name: str) -> bool:
        visibility = self.get_visibility(db, name)
        return visibility == VISIBILITY_PUBLIC

    # Cache invalidation

    def on_change(self, name: str) -> None:
        try:
            key = self._key_data(name)
            self._redis.delete(key)
            logger.debug(f"Invalidated cache for group {name}")
        except Exception as e:
            logger.warning(f"Cache invalidation error: {e}")
