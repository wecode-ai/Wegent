# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise cancellation coordination through the real cache transport boundary.

The Redis double records atomic script calls and supplies server outcomes; it
does not interpret Lua or claim to verify Redis atomicity. Real Redis integration
must separately exercise the same production scripts and cleanup interleavings.
"""

import asyncio
import inspect
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import BackgroundTasks
from redis.exceptions import ConnectionError as RedisConnectionError
from starlette.requests import Request

from app.core.cache import RedisCache
from app.services.chat.storage.response_cancel import ResponseCancelCoordinator
from app.services.chat.storage.session import SessionManager

SUBTASK_ID = 9007199254740993
CANCEL_KEY = f"chat:cancel:{SUBTASK_ID}"
INTENT_KEY = f"chat:cancel-intent:{SUBTASK_ID}"


@pytest.fixture
def cancellation():
    client = SimpleNamespace(
        set=AsyncMock(return_value=True),
        get=AsyncMock(return_value=None),
        delete=AsyncMock(return_value=1),
        eval=AsyncMock(return_value=1),
        sync=SimpleNamespace(
            set=MagicMock(return_value=True), eval=MagicMock(return_value=1)
        ),
    )
    cache = RedisCache("redis://unit-test.invalid/0")

    @asynccontextmanager
    async def connection():
        yield client

    cache._client_context = connection
    cache._get_sync_client = MagicMock(return_value=client.sync)
    manager = SessionManager()
    manager._cache = cache
    return manager, ResponseCancelCoordinator(cache), client


def assert_atomic_keys(client, *expected_keys: str) -> tuple:
    call = client.eval.await_args
    assert call is not None
    script, key_count, *arguments = call.args
    assert isinstance(script, str) and script.strip()
    assert key_count == len(expected_keys)
    assert set(arguments[:key_count]) == set(expected_keys)
    return tuple(arguments[key_count:])


@pytest.mark.asyncio
async def test_prepare_is_non_notifying_and_has_no_fixed_lifetime(cancellation):
    manager, coordinator, client = cancellation
    event = await manager.register_stream(SUBTASK_ID)
    token = coordinator.prepare(SUBTASK_ID)

    assert isinstance(token, str) and token
    assert not event.is_set()
    assert not inspect.iscoroutinefunction(coordinator.prepare)
    client.sync.set.assert_called_once()
    call = client.sync.set.call_args
    assert call.args[0] == INTENT_KEY
    assert call.args[1] in (token, token.encode())
    assert len(call.args) == 2
    assert not any(call.kwargs.get(name) for name in ("ex", "px", "exat", "pxat"))


@pytest.mark.asyncio
@pytest.mark.parametrize("server_result", [0, 1])
async def test_finalize_respects_atomic_owner_result_without_unconditional_set(
    cancellation, server_result
):
    _, coordinator, client = cancellation
    client.eval.return_value = server_result

    delivered = await coordinator.finalize(SUBTASK_ID, "the-original-intent")

    assert delivered is bool(server_result)
    arguments = assert_atomic_keys(client, INTENT_KEY, CANCEL_KEY)
    assert "the-original-intent" in arguments
    client.eval.assert_awaited_once()
    client.set.assert_not_awaited()
    client.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_abort_uses_its_exact_token_without_deleting_or_notifying_other_intents(
    cancellation,
):
    _, coordinator, client = cancellation
    client.eval.return_value = 0

    await coordinator.abort(SUBTASK_ID, "the-rolled-back-intent")

    assert "the-rolled-back-intent" in assert_atomic_keys(client, INTENT_KEY)
    client.set.assert_not_awaited()
    client.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_prestart_and_nested_registration_use_intent_preserving_atomic_operation(
    cancellation,
):
    manager, coordinator, client = cancellation
    assert await coordinator.finalize(SUBTASK_ID, "already-committed")
    client.eval.reset_mock()
    client.get.return_value = b"true"

    outer = await manager.register_stream(SUBTASK_ID)
    inner = await manager.register_stream(SUBTASK_ID)

    assert client.eval.await_count == 2
    calls = client.eval.await_args_list
    assert calls[0] == calls[1]
    assert_atomic_keys(client, INTENT_KEY, CANCEL_KEY)
    client.delete.assert_not_awaited()
    client.set.assert_not_awaited()
    assert not outer.is_set() and not inner.is_set()
    assert await manager.is_cancelled(SUBTASK_ID)
    assert inner.is_set()


@pytest.mark.asyncio
async def test_unregister_atomically_closes_intent_and_flag(cancellation):
    manager, _, client = cancellation
    await manager.register_stream(SUBTASK_ID)
    client.eval.reset_mock()

    await manager.unregister_stream(SUBTASK_ID)

    client.eval.assert_not_awaited()
    client.delete.assert_awaited_once()
    assert set(client.delete.await_args.args) == {INTENT_KEY, CANCEL_KEY}
    assert SUBTASK_ID not in manager._local_events
    client.set.assert_not_awaited()


@pytest.mark.asyncio
async def test_prepare_failure_cannot_trigger_an_unconditional_postcommit_notification(
    cancellation,
):
    manager, coordinator, client = cancellation
    event = await manager.register_stream(SUBTASK_ID)
    client.eval.reset_mock()
    client.sync.set.side_effect = RedisConnectionError("unavailable during preparation")

    token = coordinator.prepare(SUBTASK_ID)
    assert token is None
    assert not event.is_set()

    assert not await manager.finish_response_cancel(SUBTASK_ID, token)

    client.eval.assert_not_awaited()
    client.sync.eval.assert_called_once()
    assert client.sync.eval.call_args.args[1:3] == (1, INTENT_KEY)
    client.sync.set.assert_called_once()
    assert client.sync.set.call_args.args[0] == INTENT_KEY
    client.set.assert_not_awaited()
    assert event.is_set(), "The existing local signal is sent only after commit"


@pytest.mark.asyncio
async def test_finalize_transport_failure_is_logged_without_recreating_a_flag(
    cancellation, caplog
):
    _, coordinator, client = cancellation
    client.eval.side_effect = RedisConnectionError("unavailable after commit")

    assert not await coordinator.finalize(SUBTASK_ID, "committed-intent")

    assert "unavailable after commit" in caplog.text
    client.set.assert_not_awaited()
    client.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_finished_local_stream_is_not_recreated_by_delayed_notification(
    cancellation,
):
    manager, _, client = cancellation
    event = await manager.register_stream(SUBTASK_ID)
    await manager.unregister_stream(SUBTASK_ID)
    client.eval.return_value = 0
    client.set.reset_mock()

    assert not await manager.finish_response_cancel(SUBTASK_ID, "closed-intent")

    assert SUBTASK_ID not in manager._local_events
    assert not event.is_set()
    client.set.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancelled_preparation_aborts_its_token_and_preserves_cancellation(
    cancellation,
):
    _, coordinator, client = cancellation
    client.sync.set.side_effect = asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        coordinator.prepare(SUBTASK_ID)

    client.sync.eval.assert_called_once()
    assert client.sync.eval.call_args.args[1:3] == (1, INTENT_KEY)
    client.eval.assert_not_awaited()
    client.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_other_cancellation_callers_keep_the_original_boolean_protocol(
    cancellation,
):
    manager, _, client = cancellation
    event = await manager.register_stream(SUBTASK_ID)
    client.eval.reset_mock()

    assert await manager.cancel_stream(SUBTASK_ID)

    client.set.assert_awaited_once_with(CANCEL_KEY, b"true", ex=300)
    client.eval.assert_not_awaited()
    assert event.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [None, RuntimeError("commit rejected"), asyncio.CancelledError()]
)
async def test_endpoint_locks_prepares_and_commits_before_notification(
    cancellation, monkeypatch, failure
):
    from app.api.endpoints import openapi_responses as endpoint
    from app.services.chat import storage

    manager, _, client = cancellation
    event = await manager.register_stream(SUBTASK_ID)
    client.eval.reset_mock()
    manager.get_streaming_content = AsyncMock(return_value="private partial")
    manager.finish_response_cancel = AsyncMock(wraps=manager.finish_response_cancel)
    monkeypatch.setattr(storage, "session_manager", manager)
    document = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": "cancel-commit-failure",
            "namespace": "default",
            "labels": {"source": "chat_shell"},
        },
        "spec": {
            "title": "Streaming response",
            "prompt": "Continue",
            "teamRef": {"name": "agent", "namespace": "default"},
            "workspaceRef": {"name": "workspace", "namespace": "default"},
        },
        "status": {"status": "RUNNING", "progress": 50},
    }
    task = SimpleNamespace(id=38, json=document)
    subtask = SimpleNamespace(id=SUBTASK_ID, status=endpoint.SubtaskStatus.RUNNING)
    task_store = SimpleNamespace(
        get_task_by_states=MagicMock(return_value=task),
        get_by_id_for_update=MagicMock(return_value=task),
        update_json=MagicMock(),
    )
    subtask_store = SimpleNamespace(
        get_latest_assistant_for_user_by_statuses=MagicMock(return_value=subtask),
        get_basic_by_id_for_update=MagicMock(return_value=subtask),
        update_fields=MagicMock(),
        list_by_task_for_user_ordered=MagicMock(return_value=[]),
    )
    monkeypatch.setattr(endpoint, "task_store", task_store)
    monkeypatch.setattr(endpoint, "subtask_store", subtask_store)
    monkeypatch.setattr(
        endpoint.task_kinds_service, "get_task_by_id", MagicMock(return_value={})
    )
    monkeypatch.setattr(
        endpoint, "_task_to_response_object", lambda *_args, **_kwargs: "settled"
    )
    database = MagicMock()
    order = []

    def commit():
        order.append("commit")
        if failure is not None:
            raise failure

    def prepare(*_args):
        order.append("prepare")
        return True

    def atomic(script, *_args):
        order.append("finalize" if "EXPIRE" in script else "abort")
        return 1

    client.sync.set.side_effect = prepare
    client.eval.side_effect = atomic
    database.commit.side_effect = commit
    database.rollback.side_effect = lambda: order.append("rollback")
    task_store.get_by_id_for_update.side_effect = lambda *_args, **_kwargs: (
        order.append("lock-task") or task
    )
    subtask_store.get_basic_by_id_for_update.side_effect = lambda *_args, **_kwargs: (
        order.append("lock-subtask") or subtask
    )
    subtask_store.update_fields.side_effect = lambda *_args, **_kwargs: order.append(
        "write-subtask"
    )
    task_store.update_json.side_effect = lambda *_args, **_kwargs: order.append(
        "write-task"
    )
    request = Request({"type": "http", "method": "POST", "path": "/"})

    async def cancel():
        return await inspect.unwrap(endpoint.cancel_response)(
            request,
            "resp_38",
            BackgroundTasks(),
            db=database,
            current_user=SimpleNamespace(id=7),
        )

    if failure is not None:
        with pytest.raises(type(failure)):
            await cancel()
    else:
        assert await cancel() == "settled"

    database.commit.assert_called_once()
    task_store.get_by_id_for_update.assert_called_once_with(database, task_id=38)
    subtask_store.update_fields.assert_called_once()
    assert order[:6] == [
        "lock-task",
        "lock-subtask",
        "prepare",
        "write-subtask",
        "write-task",
        "commit",
    ]
    client.sync.set.assert_called_once()
    assert client.sync.set.call_args.args[0] == INTENT_KEY
    if failure is not None:
        assert order[6:] == ["rollback", "abort"]
        database.rollback.assert_called_once()
        manager.finish_response_cancel.assert_not_awaited()
        assert not event.is_set()
        assert_atomic_keys(client, INTENT_KEY)
    else:
        assert order[6:] == ["finalize"]
        database.rollback.assert_not_called()
        manager.finish_response_cancel.assert_awaited_once()
        assert event.is_set()
        assert_atomic_keys(client, INTENT_KEY, CANCEL_KEY)
    client.set.assert_not_awaited()
