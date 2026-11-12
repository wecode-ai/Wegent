"""Plugin transactions retain one worker-owned session through cleanup."""

import asyncio
import threading
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.models.kind import Kind
from app.services import plugin_write_operations as operations
from app.services.plugin_write_coordination import acquire_plugin_write_lock
from app.services.plugin_write_errors import PluginWriteError


@pytest.mark.asyncio
@pytest.mark.parametrize("ending", ("commit", "close", "raise"))
async def test_operation_owns_transaction_and_releases_lease(
    test_db, test_user, plugin_write_sessions, plugin_write_backend, monkeypatch, ending
):
    loop_thread = threading.get_ident()
    user_id = test_user.id
    sessions = []
    session_factory = operations.get_db_session
    original_configure = operations.configure_plugin_session
    failure = PluginWriteError("plugin_write_lease_lost")
    events = []

    @contextmanager
    def session():
        events.append(("open", threading.get_ident()))
        try:
            with session_factory() as db:
                sessions.append(db)
                yield db
        finally:
            events.append(("close", threading.get_ident()))

    def configure(db):
        assert db is sessions[0]
        events.append(("configure", threading.get_ident()))
        original_configure(db)

    def mutate(*, db, name):
        assert db is sessions[0] and db is not test_db
        events.append(("mutate", threading.get_ident()))
        acquire_plugin_write_lock(db, user_id, name=name)
        db.add(
            Kind(
                user_id=user_id,
                kind="InstalledPlugin",
                namespace="default",
                name=name,
                json={"spec": {}},
                is_active=True,
            )
        )
        db.flush()
        assert plugin_write_backend.values
        if ending == "raise":
            raise failure
        if ending == "commit":
            db.commit()
        return {"name": name}

    monkeypatch.setattr(operations, "get_db_session", session)
    monkeypatch.setattr(operations, "configure_plugin_session", configure)

    if ending == "raise":
        with pytest.raises(PluginWriteError) as caught:
            await operations.run_plugin_operation(mutate, name="worker-owned")
        assert caught.value is failure
    else:
        assert await operations.run_plugin_operation(mutate, name="worker-owned") == {
            "name": "worker-owned"
        }

    assert len(sessions) == 1
    assert not sessions[0].in_transaction()
    assert not plugin_write_backend.values
    assert [name for name, _ in events] == ["open", "configure", "mutate", "close"]
    assert len({thread for _, thread in events}) == 1
    assert events[0][1] != loop_thread
    saved = (
        test_db.query(Kind)
        .filter_by(
            user_id=user_id,
            kind="InstalledPlugin",
            namespace="default",
            name="worker-owned",
        )
        .count()
    )
    assert saved == (1 if ending == "commit" else 0)


@pytest.mark.asyncio
async def test_operation_wait_does_not_block_event_loop(monkeypatch):
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    started = asyncio.Event()
    release = threading.Event()
    events = []

    class WorkerSession:
        def record(self, name):
            events.append((name, threading.get_ident()))

        def rollback(self):
            self.record("rollback")

    @contextmanager
    def session():
        db = WorkerSession()
        db.record("open")
        try:
            yield db
        finally:
            db.record("close")

    def wait(*, db, value):
        db.record("wait")
        assert threading.get_ident() != loop_thread
        loop.call_soon_threadsafe(started.set)
        assert release.wait(5), "Test did not release the synchronous operation"
        return value

    monkeypatch.setattr(operations, "get_db_session", session)
    monkeypatch.setattr(
        operations, "configure_plugin_session", lambda db: db.record("configure")
    )
    result = object()
    task = asyncio.create_task(operations.run_plugin_operation(wait, value=result))
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        assert not task.done()
        assert not release.is_set()
    finally:
        release.set()
        actual = await asyncio.wait_for(task, timeout=5)

    assert actual is result
    assert [name for name, _ in events] == ["open", "configure", "wait", "close"]
    assert len({thread for _, thread in events}) == 1
    assert events[0][1] != loop_thread


@pytest.mark.asyncio
async def test_operation_failure_rolls_back_before_session_close(monkeypatch):
    events = []
    failure = RuntimeError("business operation failed")

    class WorkerSession:
        def rollback(self):
            events.append("rollback")

    @contextmanager
    def session():
        events.append("open")
        try:
            yield WorkerSession()
        finally:
            events.append("close")

    def fail(*, db):
        events.append("mutate")
        raise failure

    monkeypatch.setattr(operations, "get_db_session", session)
    monkeypatch.setattr(
        operations, "configure_plugin_session", lambda db: events.append("configure")
    )

    with pytest.raises(RuntimeError) as caught:
        await operations.run_plugin_operation(fail)

    assert caught.value is failure
    assert events == ["open", "configure", "mutate", "rollback", "close"]


def test_backoff_cannot_start_a_new_transaction_after_the_shared_deadline(monkeypatch):
    clock = [0.0]
    opened = []
    conflict = PluginWriteError("plugin_write_conflict")

    @contextmanager
    def session():
        opened.append(True)
        yield Mock()

    def fail(_db):
        clock[0] = 19.999
        raise conflict

    monkeypatch.setattr(operations, "configure_plugin_session", Mock())
    monkeypatch.setattr(operations.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(
        operations.time, "sleep", lambda _delay: clock.__setitem__(0, 20.001)
    )
    with pytest.raises(PluginWriteError) as caught:
        operations.run_plugin_transaction(fail, session)
    assert caught.value is conflict
    assert len(opened) == 1


@pytest.mark.parametrize(
    ("code", "retry_busy"),
    [
        ("plugin_write_busy", False),
        ("plugin_write_lease_lost", True),
        ("plugin_write_unavailable", True),
    ],
)
def test_snapshot_contention_policy_does_not_retry_other_failures(
    monkeypatch, code, retry_busy
):
    sessions = []
    failure = PluginWriteError(code)

    @contextmanager
    def session():
        db = Mock()
        sessions.append(db)
        yield db

    def fail(_db):
        raise failure

    def unexpected_backoff(_delay):
        pytest.fail("A nonretryable error was retried")

    monkeypatch.setattr(operations, "configure_plugin_session", Mock())
    monkeypatch.setattr(
        operations,
        "time",
        SimpleNamespace(monotonic=lambda: 0, sleep=unexpected_backoff),
    )
    with pytest.raises(PluginWriteError) as caught:
        operations.run_plugin_transaction(fail, session, retry_busy=retry_busy)
    assert caught.value is failure
    assert len(sessions) == 1
    sessions[0].rollback.assert_called_once()


def test_snapshot_contention_releases_sessions_and_stops_at_shared_deadline(
    monkeypatch,
):
    clock = [0.0]
    sessions = []
    failure = PluginWriteError("plugin_write_busy")

    @contextmanager
    def session():
        assert clock[0] < 20, "Contention opened a transaction after its deadline"
        db = Mock(closed=False)
        sessions.append(db)
        try:
            yield db
        finally:
            db.closed = True

    def backoff(delay):
        assert all(db.closed for db in sessions)
        assert 0 < delay <= 20 - clock[0]
        clock[0] += delay

    def fail(_db):
        raise failure

    monkeypatch.setattr(operations, "configure_plugin_session", Mock())
    monkeypatch.setattr(
        operations, "time", SimpleNamespace(monotonic=lambda: clock[0], sleep=backoff)
    )
    with pytest.raises(PluginWriteError) as caught:
        operations.run_plugin_transaction(fail, session, retry_busy=True)
    assert caught.value is failure
    assert clock[0] == 20
    assert len(sessions) > 2
    assert all(db.closed and db.rollback.call_count == 1 for db in sessions)
