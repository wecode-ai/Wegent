# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cached Kind reader.

Cache Key Design (Data/Index Separation):
    Data:  kind:data:{kind}:{resource_id}
    Index: kind:idx:{scope}:{kind}:{...}:{namespace}:{name} -> resource_id

Benefits:
    - Data stored once per resource
    - Index stores only resource_id
    - Null caching prevents penetration
    - TTL = 300s
"""

import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.readers.kinds import IKindReader, KindType
from wecode.cache.base import (
    CACHE_TTL,
    NULL_MARKER,
    get_redis_client,
    register_events,
)

logger = logging.getLogger(__name__)

_events_registered = False


# =============================================================================
# Public API
# =============================================================================


def wrap(base_reader: IKindReader) -> Optional[IKindReader]:
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

    reader = CachedKindReader(base_reader, redis)

    if not _events_registered:
        register_events(Kind, _on_change, reader)
        _events_registered = True

    logger.info("Kind cache loaded")
    return reader


def _on_change(operation: str, target, reader: IKindReader) -> None:
    """Handle model change event."""
    try:
        logger.info(
            f"[kind change event] {operation}: {target.kind}/{target.namespace}/{target.name}"
        )
        reader.on_change(
            kind=KindType(target.kind),
            resource_id=target.id,
            user_id=target.user_id,
            namespace=target.namespace,
            name=target.name,
        )
    except Exception as e:
        logger.warning(f"Kind change handler error: {e}")


# =============================================================================
# Cached Reader
# =============================================================================


class CachedKindReader(IKindReader):
    """Cached Kind reader using Redis."""

    def __init__(self, base: IKindReader, redis):
        self._base = base
        self._redis = redis

    # Key generation

    def _key_data(self, kind: KindType, resource_id: int) -> str:
        return f"kind:data:{kind.value}:{resource_id}"

    def _key_idx_personal(
        self, user_id: int, kind: KindType, namespace: str, name: str
    ) -> str:
        return f"kind:idx:personal:{kind.value}:{user_id}:{namespace}:{name}"

    def _key_idx_public(self, kind: KindType, namespace: str, name: str) -> str:
        return f"kind:idx:public:{kind.value}:{namespace}:{name}"

    def _key_idx_group(self, kind: KindType, namespace: str, name: str) -> str:
        return f"kind:idx:group:{kind.value}:{namespace}:{name}"

    # Cache operations

    def _get_data(self, kind: KindType, resource_id: int) -> Optional[dict]:
        try:
            import json

            data = self._redis.get(self._key_data(kind, resource_id))
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

    def _set_data(self, kind: KindType, resource_id: int, value: Kind) -> None:
        try:
            import json

            data = {
                "id": value.id,
                "user_id": value.user_id,
                "kind": value.kind,
                "namespace": value.namespace,
                "name": value.name,
                "json": value.json,
                "is_active": value.is_active,
            }
            self._redis.setex(
                self._key_data(kind, resource_id), CACHE_TTL, json.dumps(data)
            )
        except Exception as e:
            logger.warning(f"Cache set error: {e}")

    def _set_idx(self, key: str, resource_id: Optional[int]) -> None:
        try:
            value = NULL_MARKER if resource_id is None else str(resource_id)
            self._redis.setex(key, CACHE_TTL, value)
        except Exception as e:
            logger.warning(f"Cache idx set error: {e}")

    def _to_model(self, data: dict) -> Optional[Kind]:
        if not data:
            return None
        obj = Kind()
        obj.id = data.get("id")
        obj.user_id = data.get("user_id")
        obj.kind = data.get("kind")
        obj.namespace = data.get("namespace")
        obj.name = data.get("name")
        obj.json = data.get("json")
        obj.is_active = data.get("is_active")
        return obj

    # Query methods

    def get_by_id(
        self, db: Session, kind: KindType, resource_id: int
    ) -> Optional[Kind]:
        cached = self._get_data(kind, resource_id)
        if cached is not None:
            return self._to_model(cached)

        result = self._base.get_by_id(db, kind, resource_id)
        if result:
            self._set_data(kind, resource_id, result)
        return result

    def get_personal(
        self, db: Session, user_id: int, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        idx_key = self._key_idx_personal(user_id, kind, namespace, name)

        cached_id = self._get_idx(idx_key)
        if cached_id is not None:
            if cached_id == -1:
                return None
            cached = self._get_data(kind, cached_id)
            if cached is not None:
                return self._to_model(cached)

        result = self._base.get_personal(db, user_id, kind, namespace, name)
        if result:
            self._set_data(kind, result.id, result)
            self._set_idx(idx_key, result.id)
        else:
            self._set_idx(idx_key, None)
        return result

    def get_public(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        idx_key = self._key_idx_public(kind, namespace, name)

        cached_id = self._get_idx(idx_key)
        if cached_id is not None:
            if cached_id == -1:
                return None
            cached = self._get_data(kind, cached_id)
            if cached is not None:
                return self._to_model(cached)

        result = self._base.get_public(db, kind, namespace, name)
        if result:
            self._set_data(kind, result.id, result)
            self._set_idx(idx_key, result.id)
        else:
            self._set_idx(idx_key, None)
        return result

    def get_group(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        idx_key = self._key_idx_group(kind, namespace, name)

        cached_id = self._get_idx(idx_key)
        if cached_id is not None:
            if cached_id == -1:
                return None
            cached = self._get_data(kind, cached_id)
            if cached is not None:
                return self._to_model(cached)

        result = self._base.get_group(db, kind, namespace, name)
        if result:
            self._set_data(kind, result.id, result)
            self._set_idx(idx_key, result.id)
        else:
            self._set_idx(idx_key, None)
        return result

    # Cache invalidation

    def on_change(
        self,
        kind: KindType,
        resource_id: int,
        user_id: int,
        namespace: str,
        name: str,
    ) -> None:
        try:
            keys = [
                self._key_data(kind, resource_id),
                self._key_idx_personal(user_id, kind, namespace, name),
            ]
            if user_id == 0:
                keys.append(self._key_idx_public(kind, namespace, name))
            if namespace != "default":
                keys.append(self._key_idx_group(kind, namespace, name))

            self._redis.delete(*keys)
            logger.debug(f"Invalidated {len(keys)} keys for {kind.value}/{name}")
        except Exception as e:
            logger.warning(f"Cache invalidation error: {e}")
