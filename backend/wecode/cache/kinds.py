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
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.readers.kinds import IKindReader, KindType
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
        return f"kind:{CACHE_VERSION}:data:{kind.value}:{resource_id}"

    def _key_idx_personal(
        self, user_id: int, kind: KindType, namespace: str, name: str
    ) -> str:
        return f"kind:{CACHE_VERSION}:idx:personal:{kind.value}:{user_id}:{namespace}:{name}"

    def _key_idx_public(self, kind: KindType, namespace: str, name: str) -> str:
        return f"kind:{CACHE_VERSION}:idx:public:{kind.value}:{namespace}:{name}"

    def _key_idx_group(self, kind: KindType, namespace: str, name: str) -> str:
        return f"kind:{CACHE_VERSION}:idx:group:{kind.value}:{namespace}:{name}"

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

            data = model_to_dict(value)
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
        return dict_to_model(data, Kind)

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

    def get_by_ids(
        self, db: Session, kind: KindType, resource_ids: List[int]
    ) -> List[Kind]:
        if not resource_ids:
            return []

        results = []
        missing_ids = []

        # Try to get from cache first
        for rid in resource_ids:
            cached = self._get_data(kind, rid)
            if cached is not None:
                model = self._to_model(cached)
                if model:
                    results.append(model)
            else:
                missing_ids.append(rid)

        # Query missing from database
        if missing_ids:
            db_results = self._base.get_by_ids(db, kind, missing_ids)
            for item in db_results:
                self._set_data(kind, item.id, item)
                results.append(item)

        return results

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
