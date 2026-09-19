# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Redis-backed cache for Kind readers with write-through invalidation.

Reads are served from a version-free cache keyed by the resource identity.
Writes are applied to the cache after the transaction commits: the write
path re-populates every key the row could be stored under (its id key plus
the personal/public/group name key matching its current identity), and
deletes the identity keys the row used to be reachable through when the
name, namespace, or owner changed.

This is correct as long as a given Kind row is not mutated concurrently
from two sessions; concurrent writes can interleave commit order and leave
an older row in the cache. A positive TTL plus a shorter negative (miss)
TTL bounds any staleness from paths that bypass the write-through hook.

All Redis operations fail open: any error (including Redis being down)
falls back to a direct database read, and repeated failures disable the
cache for a short cooldown window to avoid paying a timeout on every
request.
"""

import json
import logging
import time
from collections.abc import Callable
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence

import redis
from sqlalchemy import event, inspect
from sqlalchemy.orm import Session, object_session

from app.core.config import settings
from app.models.kind import Kind
from app.services.readers.kinds import IKindReader, KindType

logger = logging.getLogger(__name__)

_KEY_PREFIX = "wegent:kind_cache:"
_key_prefix_override: Optional[str] = None
_PENDING_SNAPSHOTS_KEY = "kind_cache_pending_snapshots"
_PENDING_BULK_KEY = "kind_cache_pending_bulk"
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


def _prefix() -> str:
    """Active cache key prefix; tests override it per test for isolation."""
    return _key_prefix_override or _KEY_PREFIX


def set_cache_key_prefix(prefix: Optional[str]) -> None:
    """Override the cache key prefix (used by tests to isolate each case)."""
    global _key_prefix_override
    _key_prefix_override = prefix


# Set when any cached read or write-through ran in this process; lets test
# teardown skip Redis cleanup for tests that never touched the cache.
_cache_touched = False


def _mark_cache_touched() -> None:
    global _cache_touched
    _cache_touched = True


def cache_was_touched() -> bool:
    return _cache_touched


def reset_cache_touched() -> None:
    global _cache_touched
    _cache_touched = False


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

    def get_many(self, keys: Sequence[str]) -> tuple[dict[str, Optional[Kind]], bool]:
        """Return ``({key: kind_or_None}, available)`` in a single round trip.

        A key present in the mapping is a usable entry; ``None`` means a
        negative (not-found) entry. Keys absent from the mapping must be
        loaded. ``available`` is False when the cache cannot be used.
        """
        if not keys or not self._available():
            return {}, False
        try:
            payloads = self._get_client().mget(list(keys))
        except Exception as exc:
            self._on_error("get cache entries", exc)
            return {}, False

        entries: dict[str, Optional[Kind]] = {}
        for key, payload in zip(keys, payloads):
            if payload is None:
                continue
            try:
                entries[key] = _kind_from_payload(payload)
            except Exception as exc:
                logger.warning(
                    "[KindCache] Failed to decode payload for %s: %s", key, exc
                )
        return entries, True

    def get(self, key: str) -> tuple[bool, Optional[Kind]]:
        """Return ``(hit, kind)`` for a cache lookup."""
        entries, _ = self.get_many([key])
        return key in entries, entries.get(key)

    def set(
        self, key: str, kind: Optional[Kind], ttl: int, *, overwrite: bool = True
    ) -> None:
        """Store ``kind`` under ``key``.

        Read-path population uses ``overwrite=False`` (SET NX) so a slow
        reader cannot overwrite a newer value written by a committed
        write-through; write-through always overwrites.
        """
        if not self._available():
            return
        try:
            if overwrite:
                self._get_client().setex(key, ttl, _kind_to_payload(kind))
            else:
                self._get_client().set(key, _kind_to_payload(kind), ex=ttl, nx=True)
        except Exception as exc:
            self._on_error("set", exc)

    def delete(self, *keys: str) -> None:
        """Evict keys after a committed write."""
        keys = tuple(key for key in keys if key)
        if not keys or not self._available():
            return
        try:
            self._get_client().delete(*keys)
        except Exception as exc:
            self._on_error("delete", exc)

    def flush_prefix(self, prefix: str) -> int:
        """Delete every cache entry under ``prefix``; returns how many."""
        if not self._available():
            return 0
        try:
            client = self._get_client()
            keys = list(client.scan_iter(f"{prefix}*"))
            if keys:
                return client.delete(*keys)
            return 0
        except Exception as exc:
            self._on_error("flush prefix", exc)
            return 0


def _kind_value(kind: KindType | str) -> str:
    return kind.value if isinstance(kind, KindType) else str(kind)


def _ttl_for(kind: Optional[Kind]) -> int:
    """Negative entries expire sooner than successfully loaded rows."""
    if kind is not None:
        return settings.KIND_READER_CACHE_TTL_SECONDS
    return settings.KIND_READER_CACHE_MISS_TTL_SECONDS


def _safe_to_cache(db: Session, kind: Optional[Kind]) -> bool:
    """Never cache a row that carries uncommitted changes in this session."""
    info = getattr(db, "info", None)
    if isinstance(info, dict) and info.get(_PENDING_SNAPSHOTS_KEY):
        return False
    if kind is None or not isinstance(kind, Kind):
        return True
    if object_session(kind) is not db:
        return True
    if kind in db.new or kind in db.deleted:
        return False
    return not db.is_modified(kind, include_collections=False)


class CachedKindReader(IKindReader):
    """Caching decorator over a direct Kind reader.

    Cache hits return reconstructed, session-detached ``Kind`` instances.
    Read-only callers are unaffected, but write paths must load the row
    through their own session before mutating or deleting it.
    """

    def __init__(self, base: IKindReader, store: Optional[KindCacheStore] = None):
        self._base = base
        self._store = store or KindCacheStore()

    # ------------------------------------------------------------------
    # Key builders
    # ------------------------------------------------------------------

    @staticmethod
    def _id_key(kind: KindType | str, resource_id: int) -> str:
        return f"{_prefix()}id:{_kind_value(kind)}:{resource_id}"

    @staticmethod
    def _personal_key(
        kind: KindType | str, user_id: int, namespace: str, name: str
    ) -> str:
        return f"{_prefix()}personal:{_kind_value(kind)}:{user_id}:{namespace}:{name}"

    @staticmethod
    def _public_key(kind: KindType | str, namespace: str, name: str) -> str:
        return f"{_prefix()}public:{_kind_value(kind)}:{namespace}:{name}"

    @staticmethod
    def _group_key(kind: KindType | str, namespace: str, name: str) -> str:
        return f"{_prefix()}group:{_kind_value(kind)}:{namespace}:{name}"

    # ------------------------------------------------------------------
    # Cached lookups
    # ------------------------------------------------------------------

    def _cached(
        self,
        key: str,
        db: Session,
        loader: Callable[[], Optional[Kind]],
    ) -> Optional[Kind]:
        _mark_cache_touched()
        hit, kind = self._store.get(key)
        if hit:
            return kind

        kind = loader()
        if _safe_to_cache(db, kind):
            self._store.set(key, kind, _ttl_for(kind), overwrite=False)
        return kind

    def get_by_id(
        self, db: Session, kind: KindType, resource_id: int
    ) -> Optional[Kind]:
        return self._cached(
            self._id_key(kind, resource_id),
            db,
            lambda: self._base.get_by_id(db, kind, resource_id),
        )

    def get_by_ids(
        self, db: Session, kind: KindType, resource_ids: List[int]
    ) -> List[Kind]:
        if not resource_ids:
            return []

        _mark_cache_touched()
        ordered_ids = list(dict.fromkeys(resource_ids))
        keys = {
            resource_id: self._id_key(kind, resource_id) for resource_id in ordered_ids
        }
        entries, available = self._store.get_many(list(keys.values()))

        found: dict[int, Optional[Kind]] = {
            resource_id: entries[keys[resource_id]]
            for resource_id in ordered_ids
            if keys[resource_id] in entries
        }
        missing_ids = [
            resource_id for resource_id in ordered_ids if resource_id not in found
        ]
        if missing_ids:
            loaded = {
                row.id: row for row in self._base.get_by_ids(db, kind, missing_ids)
            }
            for resource_id in missing_ids:
                row = loaded.get(resource_id)
                found[resource_id] = row
                if available and _safe_to_cache(db, row):
                    self._store.set(
                        keys[resource_id], row, _ttl_for(row), overwrite=False
                    )

        return [
            item
            for resource_id in ordered_ids
            if (item := found.get(resource_id)) is not None
        ]

    def get_personal(
        self, db: Session, user_id: int, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        return self._cached(
            self._personal_key(kind, user_id, namespace, name),
            db,
            lambda: self._base.get_personal(db, user_id, kind, namespace, name),
        )

    def get_public(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        return self._cached(
            self._public_key(kind, namespace, name),
            db,
            lambda: self._base.get_public(db, kind, namespace, name),
        )

    def get_group(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        return self._cached(
            self._group_key(kind, namespace, name),
            db,
            lambda: self._base.get_group(db, kind, namespace, name),
        )

    # ------------------------------------------------------------------
    # Invalidation
    # ------------------------------------------------------------------

    def on_change(
        self,
        kind: KindType,
        resource_id: int,
        user_id: int,
        namespace: str,
        name: str,
    ) -> None:
        """Forward explicit invalidation calls to the underlying reader."""
        self._base.on_change(kind, resource_id, user_id, namespace, name)


# =============================================================================
# Write-through after commit
# =============================================================================


class _Snapshot:
    """Before/after identity of a Kind row touched by a flush."""

    __slots__ = ("kind_id", "old", "new", "deleted", "row")

    def __init__(
        self,
        kind_id: Optional[int],
        old: Optional[Dict[str, Any]],
        new: Optional[Dict[str, Any]],
        deleted: bool,
        row: Kind,
    ) -> None:
        self.kind_id = kind_id
        self.old = old
        self.new = new
        self.deleted = deleted
        self.row = row


_registered_factories: set[int] = set()
_write_through_store = KindCacheStore()


def _identity(kind: Kind) -> Dict[str, Any]:
    return {
        "kind": kind.kind,
        "user_id": kind.user_id,
        "namespace": kind.namespace,
        "name": kind.name,
    }


def _capture_snapshot_before_flush(session: Session) -> None:
    """Record before/after state for every Kind row touched by this flush.

    New rows are captured here too; their primary key is only assigned once
    the INSERT has been sent, so the snapshot is filled in at flush time and
    the id is back-filled in ``_capture_snapshot_after_flush``.
    """
    snapshots = session.info.setdefault(_PENDING_SNAPSHOTS_KEY, {})

    for instance in session.new:
        if not isinstance(instance, Kind):
            continue
        if id(instance) in snapshots:
            continue
        snapshots[id(instance)] = _Snapshot(
            instance.id, old=None, new=_identity(instance), deleted=False, row=instance
        )

    for instance in session.dirty:
        if not isinstance(instance, Kind):
            continue
        if session.is_modified(instance, include_collections=False):
            state = inspect(instance)
            existing = snapshots.get(id(instance))
            if existing is not None and existing.old is not None:
                # Keep the earliest identity across multiple flushes so keys
                # from intermediate states are still evicted at commit.
                old = existing.old
            else:
                old = _identity(instance)
                for column in ("name", "namespace", "user_id", "kind"):
                    history = state.attrs[column].history
                    if history.deleted:
                        old[column] = history.deleted[0]
            snapshots[id(instance)] = _Snapshot(
                instance.id,
                old=old,
                new=_identity(instance),
                deleted=False,
                row=instance,
            )

    for instance in session.deleted:
        if not isinstance(instance, Kind):
            continue
        existing = snapshots.get(id(instance))
        old = (
            existing.old
            if existing is not None and existing.old is not None
            else _identity(instance)
        )
        snapshots[id(instance)] = _Snapshot(
            instance.id, old=old, new=None, deleted=True, row=instance
        )


def _capture_snapshot_after_flush(session: Session) -> None:
    """Back-fill the primary key for rows captured before their INSERT."""
    snapshots = session.info.get(_PENDING_SNAPSHOTS_KEY)
    if not snapshots:
        return
    for snapshot in snapshots.values():
        if snapshot.row.id is not None:
            snapshot.kind_id = snapshot.row.id


def _keys_for_identity(identity: Dict[str, Any]) -> List[str]:
    """The name-based lookup key matching this identity's valid scope.

    ``KindReader`` only serves personal rows for ``namespace == "default"``
    and ``user_id != 0``, public rows for ``namespace == "default"`` and
    ``user_id == 0``, and group rows for ``namespace != "default"``. Writing
    a row under keys outside its valid scope would let cross-scope lookups
    resolve it, so exactly one key is produced per row.
    """
    kind = identity["kind"]
    namespace = identity["namespace"]
    name = identity["name"]
    user_id = identity["user_id"]
    if namespace == "default":
        if user_id == 0:
            return [f"{_prefix()}public:{kind}:{namespace}:{name}"]
        return [f"{_prefix()}personal:{kind}:{user_id}:{namespace}:{name}"]
    return [f"{_prefix()}group:{kind}:{namespace}:{name}"]


def _flush_snapshots_to_cache(snapshots: Dict[int, _Snapshot]) -> None:
    """Write committed Kind rows back to the cache and evict stale keys."""
    _mark_cache_touched()
    store = _write_through_store
    for snapshot in snapshots.values():
        keys_to_delete: List[str] = []
        if snapshot.old is not None and (
            snapshot.deleted or snapshot.old != snapshot.new
        ):
            keys_to_delete.extend(_keys_for_identity(snapshot.old))

        if snapshot.deleted:
            if snapshot.old is not None and snapshot.kind_id is not None:
                keys_to_delete.append(
                    f"{_prefix()}id:{snapshot.old['kind']}:{snapshot.kind_id}"
                )
        elif snapshot.row is not None and snapshot.kind_id is not None:
            row = snapshot.row
            store.set(
                f"{_prefix()}id:{row.kind}:{snapshot.kind_id}",
                row,
                _ttl_for(row),
            )
            for key in _keys_for_identity(snapshot.new):
                store.set(key, row, _ttl_for(row))

        if keys_to_delete:
            store.delete(*keys_to_delete)


def _after_bulk_kind_change(update_context: Any) -> None:
    query = getattr(update_context, "query", None)
    descriptions = getattr(query, "column_descriptions", ())
    if any(description.get("entity") is Kind for description in descriptions):
        # Bulk statements bypass the ORM unit of work, so there are no row
        # objects to write back; the entry TTL bounds this staleness.
        update_context.session.info[_PENDING_BULK_KEY] = True


def _after_commit(session: Session) -> None:
    snapshots = session.info.pop(_PENDING_SNAPSHOTS_KEY, None)
    session.info.pop(_PENDING_BULK_KEY, None)
    if not snapshots:
        return
    try:
        _flush_snapshots_to_cache(snapshots)
    except Exception as exc:
        # A failed write-through must never break the committed request; the
        # entry TTL bounds how long a stale value survives.
        logger.warning("[KindCache] Write-through failed: %s", exc)


def _after_rollback(session: Session) -> None:
    session.info.pop(_PENDING_SNAPSHOTS_KEY, None)
    session.info.pop(_PENDING_BULK_KEY, None)


def register_kind_cache_invalidation(session: Session) -> None:
    """Mark a direct bulk Kind write so its commit is observed."""
    if settings.KIND_READER_CACHE_ENABLED:
        session.info[_PENDING_BULK_KEY] = True


def _mark_kind_changes(session: Session, flush_context: Any, instances: Any) -> None:
    _capture_snapshot_before_flush(session)


def _capture_new_rows(session: Session, flush_context: Any) -> None:
    _capture_snapshot_after_flush(session)


def install_kind_change_listener(session_factory: Any) -> None:
    """Register transaction listeners on one session factory (idempotent).

    Listeners are attached to the factory instead of the global ``Session``
    class so sessions created from other factories (e.g. tests) stay clean.
    """
    if id(session_factory) in _registered_factories:
        return
    event.listen(session_factory, "before_flush", _mark_kind_changes)
    event.listen(session_factory, "after_flush_postexec", _capture_new_rows)
    event.listen(session_factory, "after_bulk_update", _after_bulk_kind_change)
    event.listen(session_factory, "after_bulk_delete", _after_bulk_kind_change)
    event.listen(session_factory, "after_commit", _after_commit)
    event.listen(session_factory, "after_rollback", _after_rollback)
    _registered_factories.add(id(session_factory))


def install_default_kind_change_listener() -> None:
    """Attach write-through listeners to the production session factory."""
    from app.db.session import SessionLocal

    install_kind_change_listener(SessionLocal)
