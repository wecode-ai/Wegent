# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Redis-backed caching wrapper for the Kind reader.

``CachedKindReader`` caches the four pure lookup methods of ``IKindReader``
(``get_by_id``, ``get_by_ids``, ``get_personal``, ``get_public``,
``get_group``). Higher-level resolution (``get_by_name_and_namespace``,
including Team sharing/permission logic) stays on the interface default
implementation, which delegates to these leaf methods, so permission
semantics are unchanged.

Invalidation has two layers:

1. SQLAlchemy ORM events on the ``Kind`` model call ``on_change`` for every
   insert/update/delete in this process, which evicts the affected keys from
   Redis (shared across all backend replicas).
2. A positive TTL plus a shorter negative (miss) TTL bound the staleness of
   any write path that bypasses ORM events.

All Redis operations fail open: any error (including Redis being down) falls
back to a direct database read, and repeated failures disable the cache for
a short cooldown window to avoid paying a timeout on every request.
"""

import json
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import redis
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.services.readers.kinds import IKindReader, KindType

logger = logging.getLogger(__name__)

_KEY_PREFIX = "wegent:kind_cache:"
_MISS_SENTINEL = "__kind_cache_miss__"
# Disable the cache for this long after a Redis failure to avoid paying a
# connection timeout on every lookup while Redis is down.
_FAILURE_COOLDOWN_SECONDS = 30.0

_KIND_COLUMNS = (
    "id",
    "user_id",
    "kind",
    "name",
    "namespace",
    "json",
    "is_active",
    "created_at",
    "updated_at",
)


def _kind_to_payload(kind: Optional[Kind]) -> str:
    """Serialize a Kind row (or a miss) to a cache payload."""
    if kind is None:
        return _MISS_SENTINEL
    data: Dict[str, Any] = {col: getattr(kind, col) for col in _KIND_COLUMNS}
    for col in ("created_at", "updated_at"):
        value = data[col]
        data[col] = value.isoformat() if isinstance(value, datetime) else None
    return json.dumps(data)


def _kind_from_payload(payload: str) -> Optional[Kind]:
    """Rebuild a transient Kind instance from a cache payload."""
    if payload == _MISS_SENTINEL:
        return None
    data = json.loads(payload)
    for col in ("created_at", "updated_at"):
        value = data.get(col)
        data[col] = datetime.fromisoformat(value) if value else None
    return Kind(**{col: data.get(col) for col in _KIND_COLUMNS})


class KindCacheStore:
    """Low-level Redis access with fail-open semantics."""

    def __init__(self) -> None:
        self._client: Optional[redis.Redis] = None
        self._disabled_until: float = 0.0

    def _get_client(self) -> Optional[redis.Redis]:
        if self._client is None:
            self._client = redis.from_url(
                settings.REDIS_URL,
                socket_timeout=0.2,
                socket_connect_timeout=0.2,
                decode_responses=True,
            )
        return self._client

    def _available(self) -> bool:
        return time.monotonic() >= self._disabled_until

    def _on_error(self, op: str, exc: Exception) -> None:
        self._disabled_until = time.monotonic() + _FAILURE_COOLDOWN_SECONDS
        logger.warning(
            "[KindCache] Redis %s failed, disabling cache for %.0fs: %s",
            op,
            _FAILURE_COOLDOWN_SECONDS,
            exc,
        )

    def get(self, key: str) -> tuple[bool, Optional[Kind]]:
        """Return (hit, kind). ``hit`` is False when the lookup must go to DB."""
        if not self._available():
            return False, None
        try:
            payload = self._get_client().get(key)
        except Exception as exc:
            self._on_error("get", exc)
            return False, None
        if payload is None:
            return False, None
        try:
            return True, _kind_from_payload(payload)
        except Exception as exc:
            logger.warning("[KindCache] Failed to decode payload for %s: %s", key, exc)
            return False, None

    def set(self, key: str, kind: Optional[Kind], ttl: int) -> None:
        if not self._available():
            return
        try:
            self._get_client().setex(key, ttl, _kind_to_payload(kind))
        except Exception as exc:
            self._on_error("set", exc)

    def delete(self, *keys: str) -> None:
        keys = tuple(k for k in keys if k)
        if not keys or not self._available():
            return
        try:
            self._get_client().delete(*keys)
        except Exception as exc:
            self._on_error("delete", exc)


def _kind_value(kind: KindType | str) -> str:
    return kind.value if isinstance(kind, KindType) else str(kind)


class CachedKindReader(IKindReader):
    """Caching decorator over any ``IKindReader`` implementation."""

    def __init__(self, base: IKindReader, store: Optional[KindCacheStore] = None):
        self._base = base
        self._store = store or KindCacheStore()

    # ------------------------------------------------------------------
    # Key builders
    # ------------------------------------------------------------------

    @staticmethod
    def _id_key(kind: KindType | str, resource_id: int) -> str:
        return f"{_KEY_PREFIX}id:{_kind_value(kind)}:{resource_id}"

    @staticmethod
    def _personal_key(
        kind: KindType | str, user_id: int, namespace: str, name: str
    ) -> str:
        return f"{_KEY_PREFIX}personal:{_kind_value(kind)}:{user_id}:{namespace}:{name}"

    @staticmethod
    def _public_key(kind: KindType | str, namespace: str, name: str) -> str:
        return f"{_KEY_PREFIX}public:{_kind_value(kind)}:{namespace}:{name}"

    @staticmethod
    def _group_key(kind: KindType | str, namespace: str, name: str) -> str:
        return f"{_KEY_PREFIX}group:{_kind_value(kind)}:{namespace}:{name}"

    # ------------------------------------------------------------------
    # Cached lookups
    # ------------------------------------------------------------------

    def _cached(
        self,
        key: str,
        loader,
    ) -> Optional[Kind]:
        hit, kind = self._store.get(key)
        if hit:
            return kind
        kind = loader()
        ttl = (
            settings.KIND_READER_CACHE_TTL_SECONDS
            if kind is not None
            else settings.KIND_READER_CACHE_MISS_TTL_SECONDS
        )
        self._store.set(key, kind, ttl)
        return kind

    def get_by_id(
        self, db: Session, kind: KindType, resource_id: int
    ) -> Optional[Kind]:
        return self._cached(
            self._id_key(kind, resource_id),
            lambda: self._base.get_by_id(db, kind, resource_id),
        )

    def get_by_ids(
        self, db: Session, kind: KindType, resource_ids: List[int]
    ) -> List[Kind]:
        if not resource_ids:
            return []
        return [
            item
            for rid in resource_ids
            if (item := self.get_by_id(db, kind, rid)) is not None
        ]

    def get_personal(
        self, db: Session, user_id: int, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        return self._cached(
            self._personal_key(kind, user_id, namespace, name),
            lambda: self._base.get_personal(db, user_id, kind, namespace, name),
        )

    def get_public(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        return self._cached(
            self._public_key(kind, namespace, name),
            lambda: self._base.get_public(db, kind, namespace, name),
        )

    def get_group(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        return self._cached(
            self._group_key(kind, namespace, name),
            lambda: self._base.get_group(db, kind, namespace, name),
        )

    # ------------------------------------------------------------------
    # Invalidation
    # ------------------------------------------------------------------

    def on_change(
        self,
        kind: KindType | str,
        resource_id: Optional[int],
        user_id: Optional[int],
        namespace: str,
        name: str,
    ) -> None:
        """Evict every cache key a changed Kind row could be stored under."""
        keys = [
            self._public_key(kind, namespace, name),
            self._group_key(kind, namespace, name),
        ]
        if resource_id is not None:
            keys.append(self._id_key(kind, resource_id))
        if user_id:
            keys.append(self._personal_key(kind, user_id, namespace, name))
        self._store.delete(*keys)


# =============================================================================
# ORM event-based invalidation
# =============================================================================

_listener_installed = False


def _on_kind_orm_change(mapper: Any, connection: Any, target: Kind) -> None:
    try:
        from app.services.readers.kinds import kindReader

        kindReader.on_change(
            target.kind,
            target.id,
            target.user_id,
            target.namespace,
            target.name,
        )
    except Exception as exc:
        # Invalidation failures must never break the write path; the TTL is
        # the safety net.
        logger.warning("[KindCache] on_change failed: %s", exc)


def install_kind_change_listener() -> None:
    """Register Kind ORM events so any write evicts the cache (idempotent)."""
    global _listener_installed
    if _listener_installed:
        return
    for name in ("after_insert", "after_update", "after_delete"):
        event.listen(Kind, name, _on_kind_orm_change)
    _listener_installed = True
