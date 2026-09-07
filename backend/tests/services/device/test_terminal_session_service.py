# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for browser terminal session ownership records."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import AsyncMock, Mock

import orjson
import pytest

from app.core.cache import RedisCache
from app.services.device import terminal_session_service
from app.services.device.terminal_session_record import TerminalSessionRecord
from app.services.device.terminal_session_service import (
    REBIND_TERMINAL_SESSION_SCRIPT,
    REVOKE_TERMINAL_SESSION_SCRIPT,
    TERMINAL_SESSION_REVOCATION_PAYLOAD,
    RedisTerminalSessionStore,
    TerminalSessionService,
)
from tests.services.device.terminal_session_fakes import InMemoryTerminalSessionStore


class FailingTerminalSessionStore:
    """Store double that fails writes for registry failure tests."""

    async def set(self, record: TerminalSessionRecord, ttl_seconds: int) -> None:
        raise RuntimeError("store unavailable")

    async def get(self, session_id: str) -> TerminalSessionRecord | None:
        return None

    async def delete(self, session_id: str) -> None:
        return None

    async def rebind_socket(
        self,
        record: TerminalSessionRecord,
        socket_id: str,
    ) -> TerminalSessionRecord | None:
        return None

    async def is_revoked(self, session_id: str) -> bool:
        return False


class CountingTerminalSessionStore(InMemoryTerminalSessionStore):
    """In-memory store that records exact session lookups."""

    def __init__(self) -> None:
        super().__init__()
        self.get_calls: list[str] = []
        self.set_calls: list[str] = []

    async def set(self, record: TerminalSessionRecord, ttl_seconds: int) -> None:
        self.set_calls.append(record.session_id)
        await super().set(record, ttl_seconds)

    async def get(self, session_id: str) -> TerminalSessionRecord | None:
        self.get_calls.append(session_id)
        return await super().get(session_id)


class BlockingTerminalSessionStore(CountingTerminalSessionStore):
    """Store double that holds one exact read so concurrent callers overlap."""

    def __init__(self) -> None:
        super().__init__()
        self.read_started = asyncio.Event()
        self.release_read = asyncio.Event()

    async def get(self, session_id: str) -> TerminalSessionRecord | None:
        self.get_calls.append(session_id)
        self.read_started.set()
        await self.release_read.wait()
        return await InMemoryTerminalSessionStore.get(self, session_id)


class FailingDeleteTerminalSessionStore(InMemoryTerminalSessionStore):
    """Store double that preserves the record when durable revocation fails."""

    async def delete(self, session_id: str) -> None:
        raise RuntimeError("store unavailable")


class SharedInvalidationHub:
    """Synchronous test hub that models Redis Pub/Sub fan-out."""

    def __init__(self) -> None:
        self._listeners: list["SharedInvalidationListener"] = []

    def listener(self) -> "SharedInvalidationListener":
        return SharedInvalidationListener(self)

    async def publish(self, session_id: str, kind: str = "revoke") -> None:
        for listener in tuple(self._listeners):
            listener.invalidate(kind, session_id)


class SharedInvalidationListener:
    """Per-process invalidation listener backed by the shared test hub."""

    def __init__(self, hub: SharedInvalidationHub) -> None:
        self._hub = hub
        self._is_coherent = False
        self._on_invalidate: Callable[[str, str], None] | None = None

    @property
    def is_coherent(self) -> bool:
        return self._is_coherent

    async def start(
        self,
        on_invalidate: Callable[[str, str], None],
        on_resync: Callable[[], None],
    ) -> None:
        self._on_invalidate = on_invalidate
        on_resync()
        self._is_coherent = True
        self._hub._listeners.append(self)

    async def stop(self) -> None:
        self._is_coherent = False
        if self in self._hub._listeners:
            self._hub._listeners.remove(self)

    def invalidate(self, kind: str, session_id: str) -> None:
        if self._is_coherent and self._on_invalidate:
            self._on_invalidate(kind, session_id)


class BroadcastingTerminalSessionStore(CountingTerminalSessionStore):
    """Shared store whose delete models the Redis atomic invalidation script."""

    def __init__(self, hub: SharedInvalidationHub) -> None:
        super().__init__()
        self._hub = hub

    async def delete(self, session_id: str) -> None:
        await super().delete(session_id)
        await self._hub.publish(session_id)


class RacingBroadcastingTerminalSessionStore(BroadcastingTerminalSessionStore):
    """Store double that pauses after reading pre-revocation state."""

    def __init__(self, hub: SharedInvalidationHub) -> None:
        super().__init__(hub)
        self.block_reads = False
        self.read_started = asyncio.Event()
        self.release_read = asyncio.Event()

    async def get(self, session_id: str) -> TerminalSessionRecord | None:
        record = await super().get(session_id)
        if self.block_reads:
            self.block_reads = False
            self.read_started.set()
            await self.release_read.wait()
        return record


class ControllableInvalidationListener:
    """Listener double for fail-closed coherence tests."""

    def __init__(self, *, coherent: bool) -> None:
        self.coherent = coherent

    @property
    def is_coherent(self) -> bool:
        return self.coherent

    async def start(
        self,
        on_invalidate: Callable[[str, str], None],
        on_resync: Callable[[], None],
    ) -> None:
        del on_invalidate
        on_resync()

    async def stop(self) -> None:
        self.coherent = False


class FakeRedisClient:
    """Exact-key Redis double with command counters."""

    def __init__(
        self,
        values: dict[str, bytes] | None = None,
        *,
        subscriber_count: int = 1,
    ) -> None:
        self.values = values or {}
        self.subscriber_count = subscriber_count
        self.get_calls: list[str] = []
        self.delete_calls: list[str] = []
        self.set_calls: list[tuple[str, bytes, int]] = []
        self.eval_calls: list[tuple[Any, ...]] = []
        self.close_calls = 0

    async def get(self, key: str) -> bytes | None:
        self.get_calls.append(key)
        return self.values.get(key)

    async def set(self, key: str, payload: bytes, *, ex: int) -> bool:
        self.set_calls.append((key, payload, ex))
        self.values[key] = payload
        return True

    async def delete(self, key: str) -> int:
        self.delete_calls.append(key)
        return int(self.values.pop(key, None) is not None)

    async def eval(self, *args: Any) -> Any:
        self.eval_calls.append(args)
        if args[0] == REVOKE_TERMINAL_SESSION_SCRIPT:
            (
                _,
                _,
                record_key,
                payload,
                _ttl,
                _channel,
                _message,
            ) = args
            self.values[record_key] = payload
            return self.subscriber_count
        if args[0] == REBIND_TERMINAL_SESSION_SCRIPT:
            (
                _,
                _,
                record_key,
                user_id,
                device_id,
                socket_id,
                _channel,
                _message,
            ) = args
            payload = self.values.get(record_key)
            if payload is None:
                return None
            record = orjson.loads(payload)
            if (
                record.get("revoked") is True
                or str(record.get("user_id")) != user_id
                or record.get("device_id") != device_id
            ):
                return None
            record["socket_id"] = socket_id
            rebound = orjson.dumps(record)
            self.values[record_key] = rebound
            return rebound
        raise AssertionError("Unexpected Redis script")

    async def scan(self, *_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("Terminal session storage must not scan Redis")

    async def keys(self, *_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("Terminal session storage must not enumerate Redis keys")

    async def aclose(self) -> None:
        self.close_calls += 1


def _record(
    session_id: str = "terminal-1",
    *,
    socket_id: str = "socket-123",
    expires_at: datetime | None = None,
) -> TerminalSessionRecord:
    return TerminalSessionRecord(
        session_id=session_id,
        user_id=7,
        device_id="device-abc",
        socket_id=socket_id,
        project_id=123,
        path="/repo",
        expires_at=expires_at or datetime.now(timezone.utc) + timedelta(minutes=5),
    )


@pytest.mark.asyncio
async def test_terminal_session_service_preserves_owner_and_device_binding():
    """Terminal session records should be retrievable and owner-scoped."""
    service = TerminalSessionService(store=InMemoryTerminalSessionStore())
    record = _record()

    await service.register(record, ttl_seconds=60)

    assert await service.get("terminal-1") == record
    assert await service.authorize("terminal-1", user_id=7) == record
    assert await service.authorize("terminal-1", user_id=8) is None

    await service.delete("terminal-1")

    assert await service.get("terminal-1") is None


@pytest.mark.asyncio
async def test_terminal_session_cache_coalesces_concurrent_exact_key_misses():
    store = BlockingTerminalSessionStore()
    record = _record()
    await store.set(record, ttl_seconds=60)
    service = TerminalSessionService(store=store)

    reads = [asyncio.create_task(service.get(record.session_id)) for _ in range(100)]
    await store.read_started.wait()
    await asyncio.sleep(0)
    store.release_read.set()

    assert await asyncio.gather(*reads) == [record] * 100
    assert store.get_calls == [record.session_id]


@pytest.mark.asyncio
async def test_terminal_session_delete_failure_keeps_cached_authorization_retryable():
    store = FailingDeleteTerminalSessionStore()
    service = TerminalSessionService(store=store)
    record = _record()
    await service.register(record, ttl_seconds=60)

    with pytest.raises(RuntimeError, match="store unavailable"):
        await service.delete(record.session_id)

    assert await service.get(record.session_id) == record
    assert service.is_revoked(record.session_id) is False


@pytest.mark.asyncio
async def test_terminal_session_rebind_updates_one_exact_session():
    store = InMemoryTerminalSessionStore()
    service = TerminalSessionService(store=store)
    record = _record()
    await service.register(record, ttl_seconds=60)

    rebound = await service.rebind_socket(record, "socket-456")

    assert rebound is not None
    assert rebound.socket_id == "socket-456"
    stored = await store.get(record.session_id)
    assert stored is not None
    assert stored.socket_id == "socket-456"


@pytest.mark.asyncio
async def test_terminal_session_rejects_unbounded_or_unsafe_ids_before_store_access():
    store = CountingTerminalSessionStore()
    service = TerminalSessionService(store=store)

    assert await service.get("../terminal-1") is None
    assert await service.get("x" * 257) is None
    with pytest.raises(ValueError, match="Invalid terminal session ID"):
        await service.register(_record("../terminal-1"), ttl_seconds=60)

    assert store.get_calls == []


@pytest.mark.asyncio
async def test_terminal_session_rejects_missing_or_expired_expiration_before_store():
    store = CountingTerminalSessionStore()
    service = TerminalSessionService(store=store)
    base_record = _record()

    invalid_records = [
        TerminalSessionRecord(
            session_id="terminal-missing-expiry",
            user_id=base_record.user_id,
            device_id=base_record.device_id,
            socket_id=base_record.socket_id,
            project_id=base_record.project_id,
            path=base_record.path,
        ),
        TerminalSessionRecord(
            session_id="terminal-expired",
            user_id=base_record.user_id,
            device_id=base_record.device_id,
            socket_id=base_record.socket_id,
            project_id=base_record.project_id,
            path=base_record.path,
            expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
        ),
    ]

    for record in invalid_records:
        with pytest.raises(ValueError, match="future expires_at"):
            await service.register(record, ttl_seconds=60)

    assert store.set_calls == []


@pytest.mark.asyncio
async def test_terminal_session_service_surfaces_registry_write_failures():
    """Terminal startup should fail if the relay registry cannot be persisted."""
    service = TerminalSessionService(store=FailingTerminalSessionStore())
    record = _record()

    with pytest.raises(RuntimeError, match="store unavailable"):
        await service.register(record, ttl_seconds=60)


@pytest.mark.asyncio
async def test_terminal_session_attach_forces_exact_store_refresh():
    store = CountingTerminalSessionStore()
    service = TerminalSessionService(store=store)
    record = _record()
    await service.register(record, ttl_seconds=60)

    result = await service.authorize(
        "terminal-1",
        user_id=7,
        refresh=True,
    )

    assert result == record
    assert store.get_calls == ["terminal-1"]


@pytest.mark.asyncio
async def test_terminal_session_device_cache_avoids_per_event_store_reads():
    store = CountingTerminalSessionStore()
    record = _record()
    await store.set(record, ttl_seconds=60)
    service = TerminalSessionService(store=store, cache_ttl_seconds=30)

    first = await service.get("terminal-1")
    second = await service.get("terminal-1")

    assert first == second == record
    assert store.get_calls == ["terminal-1"]


@pytest.mark.asyncio
async def test_terminal_session_cache_revalidates_after_short_ttl(monkeypatch):
    clock = 100.0
    monkeypatch.setattr(terminal_session_service.time, "monotonic", lambda: clock)
    store = CountingTerminalSessionStore()
    record = _record()
    await store.set(record, ttl_seconds=60)
    service = TerminalSessionService(store=store, cache_ttl_seconds=5)

    assert await service.get("terminal-1") == record
    clock = 106.0
    assert await service.get("terminal-1") == record
    assert store.get_calls == ["terminal-1", "terminal-1"]


@pytest.mark.asyncio
async def test_terminal_session_cache_revalidation_jitter_is_stable_and_bounded(
    monkeypatch,
):
    clock = 100.0
    monkeypatch.setattr(terminal_session_service.time, "monotonic", lambda: clock)
    session_ids = [f"terminal-{index}" for index in range(32)]

    first = TerminalSessionService(
        store=InMemoryTerminalSessionStore(),
        cache_ttl_seconds=5,
    )
    second = TerminalSessionService(
        store=InMemoryTerminalSessionStore(),
        cache_ttl_seconds=5,
    )
    for session_id in session_ids:
        await first.register(_record(session_id), ttl_seconds=60)
        await second.register(_record(session_id), ttl_seconds=60)

    first_revalidation_times = {
        session_id: first._cache._records[session_id].revalidate_at
        for session_id in session_ids
    }
    second_revalidation_times = {
        session_id: second._cache._records[session_id].revalidate_at
        for session_id in session_ids
    }

    assert first_revalidation_times == second_revalidation_times
    assert all(
        clock + 4 <= revalidate_at <= clock + 5
        for revalidate_at in first_revalidation_times.values()
    )
    assert len(set(first_revalidation_times.values())) > 1
    assert all(
        first._cache._records[session_id].record.authorization_valid_until
        == first_revalidation_times[session_id]
        for session_id in session_ids
    )


@pytest.mark.asyncio
async def test_terminal_session_delete_invalidates_and_revokes_local_cache():
    store = CountingTerminalSessionStore()
    service = TerminalSessionService(store=store)
    await service.register(_record(), ttl_seconds=60)

    await service.delete("terminal-1")

    assert service.is_revoked("terminal-1") is True
    assert await service.get("terminal-1", refresh=True) is None
    assert store.get_calls == []


@pytest.mark.asyncio
async def test_terminal_session_delete_invalidates_other_backend_immediately():
    hub = SharedInvalidationHub()
    store = BroadcastingTerminalSessionStore(hub)
    first = TerminalSessionService(
        store=store,
        invalidation_listener=hub.listener(),
    )
    second = TerminalSessionService(
        store=store,
        invalidation_listener=hub.listener(),
    )
    await first.start()
    await second.start()
    try:
        record = _record()
        await first.register(record, ttl_seconds=60)
        assert await second.get(record.session_id) == record
        store.get_calls.clear()

        await first.delete(record.session_id)

        assert second.is_revoked(record.session_id) is True
        assert await second.get(record.session_id) is None
        assert store.get_calls == []
    finally:
        await first.stop()
        await second.stop()


@pytest.mark.asyncio
async def test_terminal_session_reconnect_rejects_authorization_from_missed_window():
    hub = SharedInvalidationHub()
    store = BroadcastingTerminalSessionStore(hub)
    first = TerminalSessionService(
        store=store,
        invalidation_listener=hub.listener(),
    )
    second = TerminalSessionService(
        store=store,
        invalidation_listener=hub.listener(),
    )
    await first.start()
    await second.start()
    try:
        record = _record()
        await first.register(record, ttl_seconds=60)
        old_authorization = await second.get(record.session_id)
        assert old_authorization is not None

        await second.stop()
        await first.delete(record.session_id)
        await second.start()

        assert second.is_authorization_current(old_authorization) is False
        assert await second.get(record.session_id) is None
    finally:
        await first.stop()
        await second.stop()


@pytest.mark.asyncio
async def test_terminal_session_read_cannot_revive_concurrent_revocation():
    hub = SharedInvalidationHub()
    store = RacingBroadcastingTerminalSessionStore(hub)
    first = TerminalSessionService(
        store=store,
        invalidation_listener=hub.listener(),
    )
    second = TerminalSessionService(
        store=store,
        invalidation_listener=hub.listener(),
    )
    await first.start()
    await second.start()
    try:
        record = _record()
        await first.register(record, ttl_seconds=60)
        second.invalidate_socket(record.socket_id)
        store.block_reads = True

        read_task = asyncio.create_task(second.get(record.session_id))
        await store.read_started.wait()
        await first.delete(record.session_id)
        store.release_read.set()

        assert await read_task is None
        assert second.is_revoked(record.session_id) is True
        assert await second.get(record.session_id) is None
    finally:
        store.release_read.set()
        await first.stop()
        await second.stop()


@pytest.mark.asyncio
async def test_terminal_session_listener_failure_denies_cached_authorization():
    store = CountingTerminalSessionStore()
    listener = ControllableInvalidationListener(coherent=True)
    service = TerminalSessionService(
        store=store,
        invalidation_listener=listener,
    )
    await service.register(_record(), ttl_seconds=60)
    listener.coherent = False

    assert await service.get("terminal-1") is None
    assert service.is_revoked("terminal-1") is True
    assert store.get_calls == []
    with pytest.raises(RuntimeError, match="failing closed"):
        await service.register(_record("terminal-2"), ttl_seconds=60)


@pytest.mark.asyncio
async def test_terminal_session_cache_rejects_expired_records():
    store = CountingTerminalSessionStore()
    await store.set(
        _record(
            expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
        ),
        ttl_seconds=60,
    )
    service = TerminalSessionService(store=store)

    assert await service.get("terminal-1") is None
    assert store.get_calls == ["terminal-1"]


@pytest.mark.asyncio
async def test_terminal_session_cache_is_bounded_and_reloads_evicted_record():
    store = CountingTerminalSessionStore()
    first = _record("terminal-1")
    second = _record("terminal-2")
    await store.set(first, ttl_seconds=60)
    await store.set(second, ttl_seconds=60)
    service = TerminalSessionService(store=store, cache_max_entries=1)

    assert await service.get("terminal-1") == first
    assert await service.get("terminal-2") == second
    assert await service.get("terminal-1") == first
    assert store.get_calls == ["terminal-1", "terminal-2", "terminal-1"]


@pytest.mark.asyncio
async def test_terminal_session_revocation_overflow_invalidates_cache_and_epoch():
    store = CountingTerminalSessionStore()
    service = TerminalSessionService(
        store=store,
        revocation_max_entries=1,
    )
    first = _record("terminal-1")
    second = _record("terminal-2")
    valid = _record("terminal-valid")
    await service.register(first, ttl_seconds=60)
    await service.register(second, ttl_seconds=60)
    await service.register(valid, ttl_seconds=60)
    old_authorization = await service.get(valid.session_id)
    assert old_authorization is not None

    await service.delete(first.session_id)
    await service.delete(second.session_id)

    assert service.is_revoked(valid.session_id) is False
    assert service.is_authorization_current(old_authorization) is False
    assert await service.get(valid.session_id) == valid
    assert store.get_calls == ["terminal-valid"]


@pytest.mark.asyncio
async def test_revocation_overflow_cannot_revive_an_evicted_tombstone():
    hub = SharedInvalidationHub()
    store = RacingBroadcastingTerminalSessionStore(hub)
    service = TerminalSessionService(
        store=store,
        revocation_max_entries=1,
        invalidation_listener=hub.listener(),
    )
    await service.start()
    try:
        first = _record("terminal-1", socket_id="socket-1")
        second = _record("terminal-2", socket_id="socket-2")
        await service.register(first, ttl_seconds=60)
        await service.register(second, ttl_seconds=60)
        service.invalidate_socket(first.socket_id)
        store.block_reads = True

        read_task = asyncio.create_task(service.get(first.session_id))
        await store.read_started.wait()
        await service.delete(first.session_id)
        await service.delete(second.session_id)
        store.release_read.set()

        assert await read_task is None
        assert store.get_calls == [first.session_id, first.session_id]
    finally:
        store.release_read.set()
        await service.stop()


@pytest.mark.asyncio
async def test_terminal_session_socket_invalidation_forces_exact_reload():
    store = CountingTerminalSessionStore()
    service = TerminalSessionService(store=store)
    record = _record()
    await service.register(record, ttl_seconds=60)

    service.invalidate_socket("socket-123")

    assert await service.get("terminal-1") == record
    assert store.get_calls == ["terminal-1"]


@pytest.mark.asyncio
async def test_redis_terminal_session_store_uses_exact_session_keys():
    cached_record = _record()
    client = FakeRedisClient(
        {
            "terminal_session:terminal-1": orjson.dumps(cached_record.to_dict()),
        }
    )
    store = RedisTerminalSessionStore(client_factory=lambda: _async_value(client))

    result = await store.get("terminal-1")

    assert result == cached_record
    assert client.get_calls == ["terminal_session:terminal-1"]


@pytest.mark.asyncio
@pytest.mark.parametrize("writer", ["legacy", "new"])
async def test_redis_metadata_round_trips_between_old_and_new_backends(
    monkeypatch, writer
):
    record = _record()
    client = FakeRedisClient()
    legacy = RedisCache("redis://unused")
    monkeypatch.setattr(legacy, "_get_client", lambda: _async_value(client))
    store = RedisTerminalSessionStore(client_factory=lambda: _async_value(client))
    key = "terminal_session:terminal-1"
    if writer == "legacy":
        assert await legacy.set(key, record.to_dict(), 60)
    else:
        await store.set(record, 60)

    assert client.values[key] == orjson.dumps(record.to_dict())
    assert await legacy.get(key) == record.to_dict()
    assert await store.get(record.session_id) == record
    rebound = await store.rebind_socket(record, "new-socket")
    assert rebound is not None
    assert (await legacy.get(key))["socket_id"] == "new-socket"
    assert set(await legacy.get(key)) == {
        "session_id",
        "user_id",
        "device_id",
        "socket_id",
        "project_id",
        "path",
        "expires_at",
    }
    await store.delete(record.session_id)
    assert await store.get(record.session_id) is None
    # The original Backend's from_dict catches missing required fields and returns None.
    revoked = await legacy.get(key)
    assert revoked == {"revoked": True}
    with pytest.raises(KeyError):
        TerminalSessionRecord.from_dict(revoked)
    assert set(client.values) == {key}
    assert set(client.get_calls) == {key}
    assert all(command[1:3] == (1, key) for command in client.eval_calls)


@pytest.mark.asyncio
async def test_legacy_delete_without_publish_is_observed_within_five_seconds(
    monkeypatch,
):
    clock = 100.0
    monkeypatch.setattr(terminal_session_service.time, "monotonic", lambda: clock)
    monkeypatch.setattr(
        terminal_session_service.settings, "TERMINAL_PROTOCOL_V2_ENABLED", False
    )
    record = _record()
    client = FakeRedisClient()
    legacy = RedisCache("redis://unused")
    monkeypatch.setattr(legacy, "_get_client", lambda: _async_value(client))
    store = RedisTerminalSessionStore(client_factory=lambda: _async_value(client))
    # Even a longer configured TTL must not extend mixed-Backend authorization.
    service = TerminalSessionService(store=store, cache_ttl_seconds=30)
    key = "terminal_session:terminal-1"
    assert await legacy.set(key, record.to_dict(), 60)
    authorization = await service.authorize("terminal-1", user_id=7)
    assert authorization is not None
    assert authorization.authorization_valid_until <= clock + 5
    assert await legacy.delete(key)
    assert not client.eval_calls
    assert service.is_authorization_current(authorization)

    clock += 5
    assert not service.is_authorization_current(authorization)
    assert await service.get("terminal-1") is None
    assert await service.authorize("terminal-1", user_id=7, refresh=True) is None
    assert client.delete_calls == [key]
    assert set(client.get_calls) == {key}


@pytest.mark.asyncio
async def test_redis_terminal_session_store_reuses_process_owned_client():
    cached_record = _record()
    client = FakeRedisClient(
        {
            "terminal_session:terminal-1": orjson.dumps(cached_record.to_dict()),
        }
    )
    store = RedisTerminalSessionStore(
        client_factory=lambda: _async_value(client),
    )

    await store.set(cached_record, 60)
    assert await store.get("terminal-1") == cached_record
    assert await store.get("terminal-1") == cached_record

    assert client.get_calls == [
        "terminal_session:terminal-1",
        "terminal_session:terminal-1",
    ]
    rebound = await store.rebind_socket(cached_record, "new-socket")
    assert rebound is not None and rebound.socket_id == "new-socket"
    await store.delete("terminal-1")
    assert await store.is_revoked("terminal-1")
    assert client.close_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("close_error", [None, RuntimeError("pubsub close failed")])
async def test_terminal_session_redis_resources_follow_provider_ownership(
    monkeypatch, caplog, close_error
):
    messages: asyncio.Queue = asyncio.Queue()

    async def receive_message(**_kwargs: Any) -> Any:
        return await messages.get()

    pubsub = SimpleNamespace(
        subscribe=AsyncMock(),
        get_message=receive_message,
        aclose=AsyncMock(side_effect=close_error),
    )
    client = SimpleNamespace(pubsub=Mock(return_value=pubsub), aclose=AsyncMock())
    pool = SimpleNamespace(aclose=AsyncMock())
    pool_factory = Mock(return_value=pool)
    monkeypatch.setattr(
        terminal_session_service.ConnectionPool, "from_url", pool_factory
    )
    redis_factory = Mock(return_value=client)
    monkeypatch.setattr(terminal_session_service, "Redis", redis_factory)
    service = TerminalSessionService()
    try:
        await service.start()
        listener = service._invalidation_listener
        assert listener is not None and listener.is_coherent
        await listener.stop()
        assert not listener.is_coherent
        pubsub.aclose.assert_awaited_once_with()
        client.aclose.assert_not_awaited()
        pool.aclose.assert_not_awaited()
        provider = service._owned_redis_client_provider
        assert provider is not None and await provider.get_client() is client
        pool_factory.assert_called_once()
        assert "max_connections" not in pool_factory.call_args.kwargs
        redis_factory.assert_called_once_with(
            connection_pool=pool, auto_close_connection_pool=False
        )
        if close_error:
            assert "Failed to close terminal session Redis resource" in caplog.text
    finally:
        await service.stop()
    await service.stop()
    client.aclose.assert_awaited_once_with(close_connection_pool=False)
    pool.aclose.assert_awaited_once_with()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["factory", "command"])
@pytest.mark.parametrize(
    "method, operation",
    [
        ("set", "set"),
        ("get", "get"),
        ("delete", "delete"),
        ("rebind_socket", "rebind"),
        ("is_revoked", "revocation"),
    ],
)
async def test_terminal_store_errors_preserve_metrics(
    monkeypatch, failure, method, operation
):
    error = RuntimeError("Redis unavailable")
    client = SimpleNamespace(
        set=AsyncMock(side_effect=error),
        get=AsyncMock(side_effect=error),
        eval=AsyncMock(side_effect=error),
        aclose=AsyncMock(),
    )
    factory = AsyncMock(
        return_value=client, side_effect=error if failure == "factory" else None
    )
    metric = Mock()
    monkeypatch.setattr(
        terminal_session_service, "record_terminal_session_store_operation", metric
    )
    store = RedisTerminalSessionStore(factory)
    args = {"set": (_record(), 60), "rebind_socket": (_record(), "new-socket")}
    with pytest.raises(RuntimeError, match="Redis unavailable"):
        await getattr(store, method)(*args.get(method, ("terminal-1",)))
    metric.assert_called_once()
    assert metric.call_args.kwargs["operation"] == operation
    assert metric.call_args.kwargs["result"] == "error"
    assert metric.call_args.kwargs["duration_seconds"] >= 0
    client.aclose.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_session_hot_path_performs_no_additional_redis_calls():
    record = _record()
    client = FakeRedisClient(
        {
            "terminal_session:terminal-1": orjson.dumps(record.to_dict()),
        }
    )
    store = RedisTerminalSessionStore(client_factory=lambda: _async_value(client))
    service = TerminalSessionService(store=store, cache_ttl_seconds=30)

    assert await service.get(record.session_id) == record
    for _ in range(100):
        assert await service.get(record.session_id) == record

    assert client.get_calls == ["terminal_session:terminal-1"]
    assert client.eval_calls == []


@pytest.mark.asyncio
async def test_redis_terminal_session_delete_atomically_revokes_and_publishes():
    record = _record()
    client = FakeRedisClient(
        {
            "terminal_session:terminal-1": orjson.dumps(record.to_dict()),
        }
    )
    store = RedisTerminalSessionStore(client_factory=lambda: _async_value(client))

    await store.delete(record.session_id)

    assert client.eval_calls == [
        (
            REVOKE_TERMINAL_SESSION_SCRIPT,
            1,
            "terminal_session:terminal-1",
            TERMINAL_SESSION_REVOCATION_PAYLOAD,
            3600,
            "terminal_session:invalidations",
            "revoke|terminal-1",
        )
    ]
    assert (
        client.values["terminal_session:terminal-1"]
        == TERMINAL_SESSION_REVOCATION_PAYLOAD
    )


@pytest.mark.asyncio
async def test_redis_terminal_session_delete_accepts_missing_subscribers(caplog):
    client = FakeRedisClient(subscriber_count=0)
    store = RedisTerminalSessionStore(client_factory=lambda: _async_value(client))

    with caplog.at_level(
        "WARNING",
        logger="app.services.device.terminal_session_service",
    ):
        await store.delete("terminal-1")

    assert (
        client.values["terminal_session:terminal-1"]
        == TERMINAL_SESSION_REVOCATION_PAYLOAD
    )
    assert "without active invalidation subscribers" in caplog.text


async def _async_value(value: Any) -> Any:
    return value
