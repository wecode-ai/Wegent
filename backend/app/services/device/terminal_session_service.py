# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser terminal session ownership records."""

import asyncio
import logging
import re
import time
import zlib
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, Optional, Protocol

import orjson
from redis.asyncio import ConnectionPool, Redis

from app.core.config import settings
from app.services.device.terminal_metrics import (
    record_terminal_session_cache_eviction,
    record_terminal_session_cache_request,
    record_terminal_session_store_operation,
)
from app.services.device.terminal_session_record import TerminalSessionRecord

logger = logging.getLogger(__name__)

TERMINAL_SESSION_KEY_PREFIX = "terminal_session:"
TERMINAL_SESSION_INVALIDATION_CHANNEL = "terminal_session:invalidations"
TERMINAL_SESSION_CACHE_MAX_ENTRIES = settings.TERMINAL_SESSION_CACHE_MAX_ENTRIES
TERMINAL_SESSION_MAX_LIFETIME_SECONDS = 60 * 60
TERMINAL_SESSION_CACHE_TTL_SECONDS = settings.TERMINAL_SESSION_CACHE_TTL_SECONDS
TERMINAL_SESSION_LEGACY_CACHE_MAX_TTL_SECONDS = 5.0
TERMINAL_SESSION_REVOCATION_MAX_ENTRIES = 32768
TERMINAL_SESSION_INVALIDATION_READY_TIMEOUT_SECONDS = 5.0
TERMINAL_SESSION_INVALIDATION_RECONNECT_MAX_SECONDS = 5.0
TERMINAL_SESSION_ID_MAX_LENGTH = 256
TERMINAL_SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9:_-]+$")
TERMINAL_SESSION_REVOCATION_PAYLOAD = orjson.dumps({"revoked": True})
TERMINAL_SESSION_CACHE_REVALIDATION_JITTER_RATIO = 0.2

REVOKE_TERMINAL_SESSION_SCRIPT = """
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return redis.call('PUBLISH', ARGV[3], ARGV[4])
"""

REBIND_TERMINAL_SESSION_SCRIPT = """
local payload = redis.call('GET', KEYS[1])
if not payload then
  return nil
end
local record = cjson.decode(payload)
if record.revoked == true then
  return nil
end
if tostring(record.user_id) ~= ARGV[1] or record.device_id ~= ARGV[2] then
  return nil
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  return nil
end
record.socket_id = ARGV[3]
local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded, 'PX', ttl)
redis.call('PUBLISH', ARGV[4], ARGV[5])
return encoded
"""

RedisClientFactory = Callable[[], Awaitable[Any]]
InvalidationHandler = Callable[[str, str], None]
ResyncHandler = Callable[[], None]


class RedisTerminalSessionClientProvider:
    """Own one shared Redis pool for a Backend process."""

    def __init__(
        self,
        redis_url: str = settings.REDIS_URL,
    ) -> None:
        self._redis_url = redis_url
        self._pool: Optional[ConnectionPool] = None
        self._client: Optional[Redis] = None

    async def get_client(self) -> Redis:
        """Return the process-owned client, creating its pool lazily."""
        if self._client is None:
            self._pool = ConnectionPool.from_url(
                self._redis_url,
                encoding="utf-8",
                decode_responses=False,
                socket_timeout=5.0,
                socket_connect_timeout=2.0,
                retry_on_timeout=True,
            )
            self._client = Redis(
                connection_pool=self._pool,
                auto_close_connection_pool=False,
            )
        return self._client

    async def close(self) -> None:
        """Close the process-owned client and every pooled connection."""
        client = self._client
        pool = self._pool
        self._client = None
        self._pool = None
        if client is not None:
            await client.aclose(close_connection_pool=False)
        if pool is not None:
            await pool.aclose()


class TerminalSessionStore(Protocol):
    """Storage interface for terminal session records."""

    async def set(self, record: TerminalSessionRecord, ttl_seconds: int) -> None:
        """Persist a terminal session record."""

    async def get(self, session_id: str) -> Optional[TerminalSessionRecord]:
        """Load a terminal session record."""

    async def delete(self, session_id: str) -> None:
        """Delete a terminal session record."""

    async def rebind_socket(
        self,
        record: TerminalSessionRecord,
        socket_id: str,
    ) -> Optional[TerminalSessionRecord]:
        """Move an existing session to the executor's current socket."""

    async def is_revoked(self, session_id: str) -> bool:
        """Return whether the exact key contains a revocation tombstone."""


class RedisTerminalSessionStore:
    """Exact-key store borrowing the provider-owned Redis client."""

    def __init__(self, client_factory: RedisClientFactory) -> None:
        self._client_factory = client_factory

    async def set(self, record: TerminalSessionRecord, ttl_seconds: int) -> None:
        started_at = time.perf_counter()
        ttl = max(1, int(ttl_seconds))
        try:
            client = await self._client_factory()
            result = await client.set(
                _record_key(record.session_id),
                orjson.dumps(record.to_dict()),
                ex=ttl,
            )
        except Exception:
            record_terminal_session_store_operation(
                operation="set",
                result="error",
                duration_seconds=time.perf_counter() - started_at,
            )
            raise
        if not result:
            record_terminal_session_store_operation(
                operation="set",
                result="error",
                duration_seconds=time.perf_counter() - started_at,
            )
            raise RuntimeError("Failed to persist terminal session record")
        record_terminal_session_store_operation(
            operation="set",
            result="success",
            duration_seconds=time.perf_counter() - started_at,
        )

    async def get(self, session_id: str) -> Optional[TerminalSessionRecord]:
        started_at = time.perf_counter()
        try:
            client = await self._client_factory()
            data = await client.get(_record_key(session_id))
        except Exception:
            record_terminal_session_store_operation(
                operation="get",
                result="error",
                duration_seconds=time.perf_counter() - started_at,
            )
            raise
        if data is None:
            record_terminal_session_store_operation(
                operation="get",
                result="miss",
                duration_seconds=time.perf_counter() - started_at,
            )
            return None
        try:
            parsed = orjson.loads(data)
            if not isinstance(parsed, dict):
                raise TypeError("Terminal session record must be an object")
            if parsed.get("revoked") is True:
                record_terminal_session_store_operation(
                    operation="get",
                    result="revoked",
                    duration_seconds=time.perf_counter() - started_at,
                )
                return None
            record = TerminalSessionRecord.from_dict(parsed)
        except (KeyError, TypeError, ValueError, orjson.JSONDecodeError):
            record_terminal_session_store_operation(
                operation="get",
                result="invalid",
                duration_seconds=time.perf_counter() - started_at,
            )
            return None
        record_terminal_session_store_operation(
            operation="get",
            result="hit",
            duration_seconds=time.perf_counter() - started_at,
        )
        return record

    async def delete(self, session_id: str) -> None:
        started_at = time.perf_counter()
        try:
            client = await self._client_factory()
            subscriber_count = await client.eval(
                REVOKE_TERMINAL_SESSION_SCRIPT,
                1,
                _record_key(session_id),
                TERMINAL_SESSION_REVOCATION_PAYLOAD,
                TERMINAL_SESSION_MAX_LIFETIME_SECONDS,
                TERMINAL_SESSION_INVALIDATION_CHANNEL,
                _invalidation_message("revoke", session_id),
            )
        except Exception:
            record_terminal_session_store_operation(
                operation="delete",
                result="error",
                duration_seconds=time.perf_counter() - started_at,
            )
            raise
        if not isinstance(subscriber_count, int) or subscriber_count < 1:
            record_terminal_session_store_operation(
                operation="delete",
                result="unobserved",
                duration_seconds=time.perf_counter() - started_at,
            )
            logger.warning(
                "Terminal session was durably revoked without active invalidation "
                "subscribers; exact revocation state remains authoritative"
            )
            return
        record_terminal_session_store_operation(
            operation="delete",
            result="success",
            duration_seconds=time.perf_counter() - started_at,
        )

    async def rebind_socket(
        self,
        record: TerminalSessionRecord,
        socket_id: str,
    ) -> Optional[TerminalSessionRecord]:
        """Move a session to the current executor socket without scanning Redis."""
        started_at = time.perf_counter()
        try:
            client = await self._client_factory()
            payload = await client.eval(
                REBIND_TERMINAL_SESSION_SCRIPT,
                1,
                _record_key(record.session_id),
                str(record.user_id),
                record.device_id,
                socket_id,
                TERMINAL_SESSION_INVALIDATION_CHANNEL,
                _invalidation_message("invalidate", record.session_id),
            )
        except Exception:
            record_terminal_session_store_operation(
                operation="rebind",
                result="error",
                duration_seconds=time.perf_counter() - started_at,
            )
            raise
        if payload is None:
            record_terminal_session_store_operation(
                operation="rebind",
                result="miss",
                duration_seconds=time.perf_counter() - started_at,
            )
            return None
        try:
            parsed = orjson.loads(payload)
            rebound = TerminalSessionRecord.from_dict(parsed)
        except (KeyError, TypeError, ValueError, orjson.JSONDecodeError):
            record_terminal_session_store_operation(
                operation="rebind",
                result="invalid",
                duration_seconds=time.perf_counter() - started_at,
            )
            return None
        record_terminal_session_store_operation(
            operation="rebind",
            result="success",
            duration_seconds=time.perf_counter() - started_at,
        )
        return rebound

    async def is_revoked(self, session_id: str) -> bool:
        """Read one exact key to distinguish revocation from a missing session."""
        started_at = time.perf_counter()
        try:
            client = await self._client_factory()
            data = await client.get(_record_key(session_id))
        except Exception:
            record_terminal_session_store_operation(
                operation="revocation",
                result="error",
                duration_seconds=time.perf_counter() - started_at,
            )
            raise
        try:
            parsed = orjson.loads(data) if data is not None else None
            revoked = isinstance(parsed, dict) and parsed.get("revoked") is True
        except orjson.JSONDecodeError:
            revoked = False
        record_terminal_session_store_operation(
            operation="revocation",
            result="hit" if revoked else "miss",
            duration_seconds=time.perf_counter() - started_at,
        )
        return revoked


class TerminalSessionInvalidationListener(Protocol):
    """Cross-process invalidation listener used by one Backend process."""

    @property
    def is_coherent(self) -> bool:
        """Return whether this process can trust its local session cache."""

    async def start(
        self,
        on_invalidate: InvalidationHandler,
        on_resync: ResyncHandler,
    ) -> None:
        """Start listening and wait until invalidations cannot be missed."""

    async def stop(self) -> None:
        """Stop listening and release Redis resources."""


class RedisTerminalSessionInvalidationListener:
    """Own one Pub/Sub subscription, borrowing the provider-owned Redis client."""

    def __init__(
        self,
        client_factory: RedisClientFactory,
        *,
        ready_timeout_seconds: float = (
            TERMINAL_SESSION_INVALIDATION_READY_TIMEOUT_SECONDS
        ),
    ) -> None:
        self._client_factory = client_factory
        self._ready_timeout_seconds = max(0.1, ready_timeout_seconds)
        self._task: Optional[asyncio.Task[None]] = None
        self._ready = asyncio.Event()
        self._stopping = False
        self._coherent = False
        self._on_invalidate: Optional[InvalidationHandler] = None
        self._on_resync: Optional[ResyncHandler] = None

    @property
    def is_coherent(self) -> bool:
        """Return whether the subscription is active and locally resynchronized."""
        return self._coherent

    async def start(
        self,
        on_invalidate: InvalidationHandler,
        on_resync: ResyncHandler,
    ) -> None:
        """Subscribe before allowing terminal session traffic."""
        if self._task and not self._task.done():
            if self._coherent:
                return
            try:
                await self._wait_until_ready()
            except RuntimeError:
                logger.warning(
                    "Terminal session invalidation listener is still reconnecting; "
                    "terminal authorization remains fail closed"
                )
            return

        self._on_invalidate = on_invalidate
        self._on_resync = on_resync
        self._ready = asyncio.Event()
        self._stopping = False
        self._coherent = False
        self._task = asyncio.create_task(
            self._listen_forever(),
            name="terminal-session-invalidation-listener",
        )
        try:
            await self._wait_until_ready()
        except RuntimeError:
            logger.warning(
                "Terminal session invalidation listener did not become ready during "
                "startup; Backend will continue while terminal authorization remains "
                "fail closed"
            )

    async def stop(self) -> None:
        """Cancel the single listener task and fail local authorization closed."""
        self._stopping = True
        self._coherent = False
        task = self._task
        self._task = None
        if not task:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _wait_until_ready(self) -> None:
        try:
            await asyncio.wait_for(
                self._ready.wait(),
                timeout=self._ready_timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                "Terminal session invalidation subscription did not become ready"
            ) from exc

    async def _listen_forever(self) -> None:
        reconnect_delay = 0.1
        while not self._stopping:
            pubsub = None
            self._coherent = False
            try:
                client = await self._client_factory()
                pubsub = client.pubsub()
                await pubsub.subscribe(TERMINAL_SESSION_INVALIDATION_CHANNEL)

                if self._on_resync:
                    self._on_resync()
                self._coherent = True
                self._ready.set()
                reconnect_delay = 0.1

                while not self._stopping:
                    message = await pubsub.get_message(
                        ignore_subscribe_messages=True,
                        timeout=1.0,
                    )
                    invalidation = _parse_invalidation_message(message)
                    if invalidation and self._on_invalidate:
                        self._on_invalidate(*invalidation)
            except asyncio.CancelledError:
                raise
            except Exception:
                self._coherent = False
                logger.exception(
                    "Terminal session invalidation listener disconnected; "
                    "authorization is failing closed"
                )
            finally:
                self._coherent = False
                await _close_redis_resource(pubsub)

            if not self._stopping:
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(
                    reconnect_delay * 2,
                    TERMINAL_SESSION_INVALIDATION_RECONNECT_MAX_SECONDS,
                )


@dataclass(frozen=True)
class _CachedTerminalSession:
    """One exact-key terminal session cache entry."""

    record: TerminalSessionRecord
    revalidate_at: float


class _TerminalSessionCache:
    """Bounded local cache with explicit invalidation and revocation tombstones."""

    def __init__(
        self,
        *,
        max_entries: int,
        revocation_max_entries: int,
        ttl_seconds: float,
        on_revocation_overflow: Callable[[], None],
    ) -> None:
        self._max_entries = max(1, max_entries)
        self._revocation_max_entries = max(1, revocation_max_entries)
        self._ttl_seconds = max(0.1, ttl_seconds)
        self._on_revocation_overflow = on_revocation_overflow
        self._records: OrderedDict[str, _CachedTerminalSession] = OrderedDict()
        self._revoked: OrderedDict[str, float] = OrderedDict()
        self._socket_sessions: dict[str, set[str]] = {}

    def get(self, session_id: str) -> Optional[TerminalSessionRecord]:
        """Return one cached exact session unless stale, expired, or revoked."""
        now = time.monotonic()
        self._purge_revocation(session_id, now)
        if session_id in self._revoked:
            record_terminal_session_cache_request("revoked")
            return None

        entry = self._records.get(session_id)
        if not entry:
            record_terminal_session_cache_request("miss")
            return None
        if entry.revalidate_at <= now or entry.record.is_expired():
            self.invalidate(session_id)
            record_terminal_session_cache_request("stale")
            return None

        self._records.move_to_end(session_id)
        record_terminal_session_cache_request("hit")
        return entry.record

    def put(
        self,
        record: TerminalSessionRecord,
        *,
        clear_revocation: bool = False,
    ) -> None:
        """Cache one verified record until expiry or explicit invalidation."""
        if record.is_expired():
            self.invalidate(record.session_id)
            return

        if clear_revocation:
            self._revoked.pop(record.session_id, None)
        elif self.is_revoked(record.session_id):
            return
        self._remove_record(record.session_id)
        self._records[record.session_id] = _CachedTerminalSession(
            record=record,
            revalidate_at=(
                time.monotonic()
                + _stable_cache_revalidation_delay(
                    record.session_id,
                    self._ttl_seconds,
                )
            ),
        )
        self._socket_sessions.setdefault(record.socket_id, set()).add(record.session_id)
        self._evict_excess()

    def revoke(self, session_id: str) -> None:
        """Invalidate one record and retain a bounded local revocation tombstone."""
        self._remove_record(session_id)
        now = time.monotonic()
        self._purge_expired_revocations(now)
        revoked_until = now + TERMINAL_SESSION_MAX_LIFETIME_SECONDS
        self._revoked[session_id] = revoked_until
        self._revoked.move_to_end(session_id)
        if len(self._revoked) > self._revocation_max_entries:
            self._revoked.clear()
            self._revoked[session_id] = revoked_until
            self.invalidate_all()
            self._on_revocation_overflow()
            record_terminal_session_cache_request("revocation_overflow")

    def is_revoked(self, session_id: str) -> bool:
        """Return whether this process has explicitly revoked the session."""
        now = time.monotonic()
        self._purge_revocation(session_id, now)
        return session_id in self._revoked

    def invalidate(self, session_id: str) -> None:
        """Remove one exact session from the local record cache."""
        self._remove_record(session_id)

    def invalidate_all(self) -> None:
        """Drop all bounded record state after a Pub/Sub reconnect."""
        self._records.clear()
        self._socket_sessions.clear()

    def invalidate_socket(self, socket_id: str) -> None:
        """Remove records bound to one disconnected executor socket."""
        session_ids = tuple(self._socket_sessions.pop(socket_id, set()))
        for session_id in session_ids:
            self._records.pop(session_id, None)

    def _remove_record(self, session_id: str) -> None:
        entry = self._records.pop(session_id, None)
        if not entry:
            return
        socket_sessions = self._socket_sessions.get(entry.record.socket_id)
        if not socket_sessions:
            return
        socket_sessions.discard(session_id)
        if not socket_sessions:
            self._socket_sessions.pop(entry.record.socket_id, None)

    def _evict_excess(self) -> None:
        while len(self._records) > self._max_entries:
            session_id, entry = self._records.popitem(last=False)
            record_terminal_session_cache_eviction()
            socket_sessions = self._socket_sessions.get(entry.record.socket_id)
            if socket_sessions:
                socket_sessions.discard(session_id)
                if not socket_sessions:
                    self._socket_sessions.pop(entry.record.socket_id, None)

    def _purge_revocation(self, session_id: str, now: float) -> None:
        revoked_until = self._revoked.get(session_id)
        if revoked_until is not None and revoked_until <= now:
            self._revoked.pop(session_id, None)

    def _purge_expired_revocations(self, now: float) -> None:
        while self._revoked:
            session_id, revoked_until = next(iter(self._revoked.items()))
            if revoked_until > now:
                return
            self._revoked.pop(session_id, None)


class TerminalSessionService:
    """Manage terminal session ownership and relay routing records."""

    def __init__(
        self,
        store: Optional[TerminalSessionStore] = None,
        *,
        cache_max_entries: int = TERMINAL_SESSION_CACHE_MAX_ENTRIES,
        cache_ttl_seconds: float = TERMINAL_SESSION_CACHE_TTL_SECONDS,
        revocation_max_entries: int = TERMINAL_SESSION_REVOCATION_MAX_ENTRIES,
        invalidation_listener: Optional[TerminalSessionInvalidationListener] = None,
    ) -> None:
        self._owned_redis_client_provider: Optional[
            RedisTerminalSessionClientProvider
        ] = None
        if store is None:
            self._owned_redis_client_provider = RedisTerminalSessionClientProvider()
            store = RedisTerminalSessionStore(
                self._owned_redis_client_provider.get_client,
            )
        self._invalidation_listener = invalidation_listener
        if self._owned_redis_client_provider and invalidation_listener is None:
            self._invalidation_listener = RedisTerminalSessionInvalidationListener(
                self._owned_redis_client_provider.get_client,
            )
        self._store = store
        self._authorization_epoch = 0
        if not settings.TERMINAL_PROTOCOL_V2_ENABLED:
            # Original Backend replicas delete exact keys without publishing invalidations.
            cache_ttl_seconds = min(
                cache_ttl_seconds, TERMINAL_SESSION_LEGACY_CACHE_MAX_TTL_SECONDS
            )
        self._cache_ttl_seconds = max(0.1, cache_ttl_seconds)
        self._inflight_loads: dict[
            str,
            asyncio.Task[Optional[TerminalSessionRecord]],
        ] = {}
        self._cache = _TerminalSessionCache(
            max_entries=cache_max_entries,
            revocation_max_entries=revocation_max_entries,
            ttl_seconds=cache_ttl_seconds,
            on_revocation_overflow=self._advance_authorization_epoch,
        )

    async def start(self) -> None:
        """Start cross-process invalidation before serving terminal traffic."""
        if self._invalidation_listener:
            await self._invalidation_listener.start(
                self._handle_invalidation,
                self._resynchronize,
            )

    async def stop(self) -> None:
        """Stop cross-process invalidation and fail cached authorization closed."""
        try:
            if self._invalidation_listener:
                await self._invalidation_listener.stop()
        finally:
            if self._owned_redis_client_provider:
                await self._owned_redis_client_provider.close()

    async def register(
        self,
        record: TerminalSessionRecord,
        ttl_seconds: int,
    ) -> None:
        """Register a terminal session record with a TTL."""
        session_id = normalize_terminal_session_id(record.session_id)
        if not session_id or session_id != record.session_id:
            raise ValueError("Invalid terminal session ID")
        if record.is_expired():
            raise ValueError("Terminal session must have a future expires_at")
        self._require_coherent()
        await self._store.set(record, ttl_seconds)
        self._cache.put(
            self._stamp_authorization(record),
            clear_revocation=True,
        )

    async def get(
        self,
        session_id: str,
        *,
        refresh: bool = False,
    ) -> Optional[TerminalSessionRecord]:
        """Load a terminal session record by ID."""
        session_id = normalize_terminal_session_id(session_id)
        if not session_id:
            return None
        if not self._is_coherent():
            record_terminal_session_cache_request("incoherent")
            return None
        if self._cache.is_revoked(session_id):
            record_terminal_session_cache_request("revoked")
            return None
        if not refresh:
            cached = self._cache.get(session_id)
            if cached:
                return cached

        task = self._inflight_loads.get(session_id)
        if task is None:
            task = asyncio.create_task(self._load_and_cache(session_id))
            self._inflight_loads[session_id] = task
            task.add_done_callback(
                lambda completed, target=session_id: self._remove_inflight_load(
                    target,
                    completed,
                )
            )
        return await asyncio.shield(task)

    async def authorize(
        self,
        session_id: str,
        *,
        user_id: int,
        refresh: bool = False,
    ) -> Optional[TerminalSessionRecord]:
        """Return the session record only when it belongs to the user."""
        record = await self.get(session_id, refresh=refresh)
        if not record or record.user_id != user_id:
            return None
        return record

    async def delete(self, session_id: str) -> None:
        """Remove a terminal session record."""
        session_id = normalize_terminal_session_id(session_id)
        if not session_id:
            return
        await self._store.delete(session_id)
        self._cache.revoke(session_id)

    async def rebind_socket(
        self,
        record: TerminalSessionRecord,
        socket_id: str,
    ) -> Optional[TerminalSessionRecord]:
        """Rebind one exact session after its executor reconnects."""
        if not normalize_terminal_session_id(record.session_id) or not socket_id:
            return None
        rebound = await self._store.rebind_socket(record, socket_id)
        if not rebound or rebound.is_expired():
            self._cache.invalidate(record.session_id)
            return None
        authorized = self._stamp_authorization(rebound)
        self._cache.put(authorized)
        return authorized

    def is_revoked(self, session_id: str) -> bool:
        """Return whether this process has revoked one exact session."""
        return bool(session_id) and (
            not self._is_coherent() or self._cache.is_revoked(session_id)
        )

    async def is_durably_revoked(self, session_id: str) -> bool:
        """Confirm a duplicate terminal exit using one exact Redis key."""
        session_id = normalize_terminal_session_id(session_id)
        if not session_id:
            return False
        if self._cache.is_revoked(session_id):
            return True
        revoked = await self._store.is_revoked(session_id)
        if revoked:
            self._cache.revoke(session_id)
        return revoked

    def is_authorization_current(self, record: TerminalSessionRecord) -> bool:
        """Reject socket-bound authorization created before a listener resync."""
        return (
            self._is_coherent()
            and isinstance(record, TerminalSessionRecord)
            and record.authorization_epoch == self._authorization_epoch
            and record.authorization_is_fresh()
        )

    def invalidate_socket(self, socket_id: str) -> None:
        """Invalidate local records bound to one executor socket."""
        if socket_id:
            self._cache.invalidate_socket(socket_id)

    def _is_coherent(self) -> bool:
        return (
            self._invalidation_listener is None
            or self._invalidation_listener.is_coherent
        )

    def _require_coherent(self) -> None:
        if not self._is_coherent():
            raise RuntimeError(
                "Terminal session invalidation listener is unavailable; "
                "registration is failing closed"
            )

    async def _load_current_record(
        self,
        session_id: str,
    ) -> Optional[TerminalSessionRecord]:
        for _ in range(2):
            authorization_epoch = self._authorization_epoch
            record = await self._store.get(session_id)
            if not self._is_coherent() or self._cache.is_revoked(session_id):
                record_terminal_session_cache_request("invalidated_during_read")
                return None
            if authorization_epoch == self._authorization_epoch:
                return record
        record_terminal_session_cache_request("resync_during_read")
        return None

    async def _load_and_cache(
        self,
        session_id: str,
    ) -> Optional[TerminalSessionRecord]:
        record = await self._load_current_record(session_id)
        if not record or record.is_expired():
            self._cache.invalidate(session_id)
            return None
        authorized_record = self._stamp_authorization(record)
        self._cache.put(authorized_record)
        return authorized_record

    def _remove_inflight_load(
        self,
        session_id: str,
        task: asyncio.Task[Optional[TerminalSessionRecord]],
    ) -> None:
        if self._inflight_loads.get(session_id) is task:
            self._inflight_loads.pop(session_id, None)

    def _handle_invalidation(self, kind: str, session_id: str) -> None:
        if kind == "revoke":
            self._cache.revoke(session_id)
            return
        self._cache.invalidate(session_id)

    def _resynchronize(self) -> None:
        self._cache.invalidate_all()
        self._advance_authorization_epoch()

    def _advance_authorization_epoch(self) -> None:
        self._authorization_epoch += 1

    def _stamp_authorization(
        self,
        record: TerminalSessionRecord,
    ) -> TerminalSessionRecord:
        return replace(
            record,
            authorization_epoch=self._authorization_epoch,
            authorization_valid_until=(
                time.monotonic()
                + _stable_cache_revalidation_delay(
                    record.session_id,
                    self._cache_ttl_seconds,
                )
            ),
        )


def _record_key(session_id: str) -> str:
    return f"{TERMINAL_SESSION_KEY_PREFIX}{session_id}"


def _stable_cache_revalidation_delay(session_id: str, ttl_seconds: float) -> float:
    """Spread revalidation earlier without extending the authorization TTL."""
    ttl = max(0.1, ttl_seconds)
    jitter_unit = zlib.crc32(session_id.encode("utf-8")) / 0xFFFFFFFF
    jitter_seconds = (
        ttl * TERMINAL_SESSION_CACHE_REVALIDATION_JITTER_RATIO * jitter_unit
    )
    return max(0.1, ttl - jitter_seconds)


def normalize_terminal_session_id(value: Any) -> str:
    """Return a bounded terminal session ID safe for exact Redis access."""
    if not isinstance(value, str):
        return ""
    session_id = value.strip()
    if (
        not session_id
        or len(session_id) > TERMINAL_SESSION_ID_MAX_LENGTH
        or not TERMINAL_SESSION_ID_PATTERN.fullmatch(session_id)
    ):
        return ""
    return session_id


def _invalidation_message(kind: str, session_id: str) -> str:
    return f"{kind}|{session_id}"


def _parse_invalidation_message(message: Any) -> Optional[tuple[str, str]]:
    if not isinstance(message, dict) or message.get("type") != "message":
        return None
    data = message.get("data")
    if isinstance(data, bytes):
        try:
            data = data.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if not isinstance(data, str):
        return None
    kind, separator, raw_session_id = data.partition("|")
    session_id = normalize_terminal_session_id(raw_session_id)
    if separator != "|" or kind not in {"invalidate", "revoke"} or not session_id:
        return None
    return kind, session_id


async def _close_redis_resource(resource: Any) -> None:
    if resource is None:
        return
    try:
        await resource.aclose()
    except Exception:
        logger.warning("Failed to close terminal session Redis resource", exc_info=True)


terminal_session_service = TerminalSessionService()
