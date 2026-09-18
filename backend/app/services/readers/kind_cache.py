# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Redis-backed cache and transaction-safe invalidation for Kind readers."""

import json
import logging
import time
from collections.abc import Callable
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
_GENERATION_KEY = f"{_KEY_PREFIX}generation"
_PENDING_INVALIDATION_KEY = "kind_cache_pending_invalidation"
_MISS_SENTINEL = "__kind_cache_miss__"
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
    data: Dict[str, Any] = {column: getattr(kind, column) for column in _KIND_COLUMNS}
    for column in ("created_at", "updated_at"):
        value = data[column]
        data[column] = value.isoformat() if isinstance(value, datetime) else None
    return json.dumps(data)


def _kind_from_payload(payload: str) -> Optional[Kind]:
    """Rebuild a transient Kind instance from a cache payload."""
    if payload == _MISS_SENTINEL:
        return None
    data = json.loads(payload)
    for column in ("created_at", "updated_at"):
        value = data.get(column)
        data[column] = datetime.fromisoformat(value) if value else None
    return Kind(**{column: data.get(column) for column in _KIND_COLUMNS})


class KindCacheStore:
    """Low-level Redis access with fail-open semantics."""

    def __init__(self) -> None:
        self._client: Optional[redis.Redis] = None
        self._disabled_until = 0.0

    def _get_client(self) -> redis.Redis:
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

    def _on_error(self, operation: str, exc: Exception) -> None:
        self._disabled_until = time.monotonic() + _FAILURE_COOLDOWN_SECONDS
        logger.warning(
            "[KindCache] Redis %s failed, disabling cache for %.0fs: %s",
            operation,
            _FAILURE_COOLDOWN_SECONDS,
            exc,
        )

    def get(self, key: str) -> tuple[bool, Optional[Kind], Optional[str]]:
        """Return ``(hit, kind, generation)`` for a cache lookup."""
        if not self._available():
            return False, None, None
        try:
            generation, payload = self._get_client().mget((_GENERATION_KEY, key))
        except Exception as exc:
            self._on_error("get cache entry", exc)
            return False, None, None
        generation = generation or "0"
        if payload is None:
            return False, None, generation
        try:
            envelope = json.loads(payload)
            if envelope.get("generation") != generation:
                return False, None, generation
            return True, _kind_from_payload(envelope["payload"]), generation
        except Exception as exc:
            logger.warning("[KindCache] Failed to decode payload for %s: %s", key, exc)
            return False, None, generation

    def set(
        self,
        key: str,
        generation: str,
        kind: Optional[Kind],
        ttl: int,
    ) -> None:
        if not self._available():
            return
        try:
            payload = json.dumps(
                {
                    "generation": generation,
                    "payload": _kind_to_payload(kind),
                }
            )
            self._get_client().setex(key, ttl, payload)
        except Exception as exc:
            self._on_error("set", exc)

    def bump_generation(self) -> None:
        """Invalidate all Kind cache entries after a successful DB commit."""
        if not self._available():
            return
        try:
            self._get_client().incr(_GENERATION_KEY)
        except Exception as exc:
            self._on_error("increment generation", exc)


def _kind_value(kind: KindType | str) -> str:
    return kind.value if isinstance(kind, KindType) else str(kind)


class CachedKindReader(IKindReader):
    """Caching decorator over a direct Kind reader."""

    def __init__(self, base: IKindReader, store: Optional[KindCacheStore] = None):
        self._base = base
        self._store = store or KindCacheStore()

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

    def _cached(
        self,
        key: str,
        loader: Callable[[], Optional[Kind]],
    ) -> Optional[Kind]:
        hit, kind, generation = self._store.get(key)
        if generation is None:
            return loader()
        if hit:
            return kind

        kind = loader()
        ttl = (
            settings.KIND_READER_CACHE_TTL_SECONDS
            if kind is not None
            else settings.KIND_READER_CACHE_MISS_TTL_SECONDS
        )
        self._store.set(key, generation, kind, ttl)
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
            for resource_id in resource_ids
            if (item := self.get_by_id(db, kind, resource_id)) is not None
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

    def on_change(
        self,
        kind: KindType,
        resource_id: int,
        user_id: int,
        namespace: str,
        name: str,
    ) -> None:
        """Keep reader extension hooks working for explicit invalidation callers."""
        self._base.on_change(kind, resource_id, user_id, namespace, name)
        self._store.bump_generation()


_listener_installed = False
_invalidation_store = KindCacheStore()


def _mark_pending_invalidation(session: Session) -> None:
    session.info[_PENDING_INVALIDATION_KEY] = True


def _has_kind_change(session: Session) -> bool:
    return any(
        isinstance(instance, Kind)
        for instance in (*session.new, *session.dirty, *session.deleted)
    )


def _after_bulk_kind_change(update_context: Any) -> None:
    query = getattr(update_context, "query", None)
    descriptions = getattr(query, "column_descriptions", ())
    if any(description.get("entity") is Kind for description in descriptions):
        _mark_pending_invalidation(update_context.session)


def _after_commit(session: Session) -> None:
    if not session.info.pop(_PENDING_INVALIDATION_KEY, False):
        return
    _invalidation_store.bump_generation()


def _after_rollback(session: Session) -> None:
    session.info.pop(_PENDING_INVALIDATION_KEY, None)


def register_kind_cache_invalidation(session: Session) -> None:
    """Mark a direct/bulk Kind write for invalidation after its transaction commits."""
    if settings.KIND_READER_CACHE_ENABLED:
        _mark_pending_invalidation(session)


def install_kind_change_listener() -> None:
    """Register transaction listeners once for all synchronous SQLAlchemy sessions."""
    global _listener_installed
    if _listener_installed:
        return

    @event.listens_for(Session, "before_flush")
    def mark_kind_changes(session: Session, flush_context: Any, instances: Any) -> None:
        if _has_kind_change(session):
            _mark_pending_invalidation(session)

    event.listen(Session, "after_bulk_update", _after_bulk_kind_change)
    event.listen(Session, "after_bulk_delete", _after_bulk_kind_change)
    event.listen(Session, "after_commit", _after_commit)
    event.listen(Session, "after_rollback", _after_rollback)
    _listener_installed = True
