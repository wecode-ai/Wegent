# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import inspect as sqlalchemy_inspect

from app.api.ws import chat_namespace, wework_runtime_namespace
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services import board_team_continuation
from app.services.chat import pipeline_advance
from app.services.chat.storage import session_manager, task_manager
from app.services.chat.trigger.unified import _worker_entity_reference


async def _assert_loop_runs_while_blocked(
    operation: asyncio.Task,
    started: threading.Event,
    release: threading.Event,
):
    for _ in range(100):
        if started.is_set():
            break
        await asyncio.sleep(0.01)
    assert started.is_set()

    heartbeat = asyncio.Event()
    asyncio.get_running_loop().call_soon(heartbeat.set)
    await asyncio.wait_for(heartbeat.wait(), timeout=0.2)
    assert not operation.done()
    release.set()
    return await asyncio.wait_for(operation, timeout=1)


@pytest.mark.asyncio
async def test_connect_authentication_does_not_block_event_loop(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def blocking_verify(_token):
        started.set()
        release.wait(timeout=1)
        return SimpleNamespace(id=7, user_name="alice")

    namespace = chat_namespace.ChatNamespace()
    monkeypatch.setattr(chat_namespace, "verify_jwt_token", blocking_verify)
    monkeypatch.setattr(chat_namespace, "get_token_expiry", lambda _token: 123)
    monkeypatch.setattr(namespace, "save_session", AsyncMock())
    monkeypatch.setattr(namespace, "enter_room", AsyncMock())

    operation = asyncio.create_task(
        namespace.on_connect("sid-1", {}, {"token": "token"})
    )
    await _assert_loop_runs_while_blocked(operation, started, release)


@pytest.mark.asyncio
async def test_wework_connect_authentication_does_not_block_event_loop(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def blocking_verify(_token):
        started.set()
        release.wait(timeout=1)
        return SimpleNamespace(id=7, user_name="alice", email="alice@example.com")

    namespace = wework_runtime_namespace.WeworkRuntimeNamespace()
    monkeypatch.setattr(
        wework_runtime_namespace,
        "verify_jwt_token",
        blocking_verify,
    )
    monkeypatch.setattr(
        wework_runtime_namespace,
        "get_token_expiry",
        lambda _token: 123,
    )
    monkeypatch.setattr(
        wework_runtime_namespace,
        "save_connect_session",
        AsyncMock(),
    )
    monkeypatch.setattr(
        wework_runtime_namespace,
        "enter_connect_room",
        AsyncMock(),
    )

    operation = asyncio.create_task(
        namespace.on_connect("sid-1", {}, {"token": "token"})
    )
    await _assert_loop_runs_while_blocked(operation, started, release)


@pytest.mark.asyncio
async def test_chat_send_database_preparation_does_not_block_event_loop(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def blocking_prepare(_user_id, payload):
        started.set()
        release.wait(timeout=1)
        return chat_namespace._ChatSendPreparation(
            payload=payload,
            response={"error": "stop after preparation"},
        )

    namespace = chat_namespace.ChatNamespace()
    monkeypatch.setattr(namespace, "_check_token_expiry", AsyncMock(return_value=False))
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7, "user_name": "alice"}),
    )
    monkeypatch.setattr(chat_namespace, "_prepare_chat_send", blocking_prepare)

    operation = asyncio.create_task(
        namespace.on_chat_send("sid-1", {"team_id": 8, "message": "hello"})
    )
    result = await _assert_loop_runs_while_blocked(operation, started, release)
    assert result == {"error": "stop after preparation"}


@pytest.mark.asyncio
async def test_chat_retry_database_preparation_does_not_block_event_loop(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def blocking_prepare(_payload, _user_id):
        started.set()
        release.wait(timeout=1)
        return {"error": "stop after preparation"}

    namespace = chat_namespace.ChatNamespace()
    monkeypatch.setattr(namespace, "_check_token_expiry", AsyncMock(return_value=False))
    monkeypatch.setattr(
        namespace, "get_session", AsyncMock(return_value={"user_id": 7})
    )
    monkeypatch.setattr(chat_namespace, "can_access_task", AsyncMock(return_value=True))
    monkeypatch.setattr(
        chat_namespace,
        "_prepare_chat_retry_dispatch_for_user",
        blocking_prepare,
    )

    operation = asyncio.create_task(
        namespace.on_chat_retry("sid-1", {"task_id": 9, "subtask_id": 10})
    )
    result = await _assert_loop_runs_while_blocked(operation, started, release)
    assert result == {"error": "stop after preparation"}


@pytest.mark.asyncio
async def test_task_creation_storage_does_not_block_event_loop(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    creation = task_manager.TaskCreationResult(
        task=SimpleNamespace(id=1),
        user_subtask=SimpleNamespace(id=2),
        assistant_subtask=None,
        ai_triggered=False,
    )

    def blocking_storage(*_args):
        started.set()
        release.wait(timeout=1)
        return task_manager._NonblockingTaskCreationOutput(
            creation=creation,
            redis_history=[],
            memory=None,
            group_notification=None,
        )

    monkeypatch.setattr(
        task_manager,
        "_create_chat_task_nonblocking_sync",
        blocking_storage,
    )
    monkeypatch.setattr(
        task_manager,
        "run_task_creation_side_effects",
        AsyncMock(),
    )
    operation = asyncio.create_task(
        task_manager.create_chat_task_nonblocking(
            user_id=7,
            team_id=8,
            message="hello",
            params=task_manager.TaskCreationParams(message="hello"),
        )
    )
    result = await _assert_loop_runs_while_blocked(operation, started, release)
    assert result is creation


def test_persisted_chat_creation_keeps_identity_when_detached(test_db, test_user):
    task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name="detached-chat-task",
        namespace="default",
        json={},
    )
    test_db.add(task)
    test_db.flush()
    user_subtask = Subtask(
        user_id=test_user.id,
        task_id=task.id,
        team_id=1,
        title="User message",
        bot_ids=[],
        role=SubtaskRole.USER,
        status=SubtaskStatus.COMPLETED,
        completed_at=datetime.now(),
    )
    assistant_subtask = Subtask(
        user_id=test_user.id,
        task_id=task.id,
        team_id=1,
        title="Assistant message",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        status=SubtaskStatus.PENDING,
        completed_at=datetime(1970, 1, 1),
    )
    test_db.add_all((user_subtask, assistant_subtask))
    test_db.commit()
    creation = task_manager.TaskCreationResult(
        task=task,
        user_subtask=user_subtask,
        assistant_subtask=assistant_subtask,
        ai_triggered=True,
    )

    task_manager._detach_task_creation_result(test_db, creation)

    for entity, model in (
        (task, TaskResource),
        (user_subtask, Subtask),
        (assistant_subtask, Subtask),
    ):
        state = sqlalchemy_inspect(entity)
        assert state.detached
        assert state.identity == (entity.id,)
        reference = _worker_entity_reference(entity, model)
        assert reference.identity == entity.id


@pytest.mark.asyncio
async def test_redis_history_failure_does_not_abort_persisted_task(monkeypatch):
    creation = task_manager.TaskCreationResult(
        task=SimpleNamespace(id=1),
        user_subtask=SimpleNamespace(id=2),
        assistant_subtask=None,
        ai_triggered=False,
    )
    output = task_manager._NonblockingTaskCreationOutput(
        creation=creation,
        redis_history=[{"role": "user", "content": "previous"}],
        memory=None,
        group_notification=None,
    )
    monkeypatch.setattr(
        session_manager,
        "get_chat_history",
        AsyncMock(side_effect=RuntimeError("redis unavailable")),
    )

    await task_manager.run_task_creation_side_effects(output)


@pytest.mark.asyncio
async def test_pipeline_advance_storage_does_not_block_event_loop(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def blocking_prepare(*_args):
        started.set()
        release.wait(timeout=1)
        return pipeline_advance._PipelineAdvancePreparation(
            advance_result={"success": False, "error": "stop after preparation"},
            user=None,
            team=None,
            payload=None,
        )

    monkeypatch.setattr(pipeline_advance, "_prepare_pipeline_advance", blocking_prepare)
    operation = asyncio.create_task(
        pipeline_advance.advance_pipeline_stage_and_send(
            user_id=7,
            team_id=8,
            task_id=9,
            message="continue",
            payload=SimpleNamespace(),
            skip_sid=None,
            auth_token="",
        )
    )
    result = await _assert_loop_runs_while_blocked(operation, started, release)
    assert result == {"error": "stop after preparation"}


@pytest.mark.asyncio
async def test_board_continuation_storage_does_not_block_event_loop(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    result = board_team_continuation.BoardTeamContinuationResult(
        message=SimpleNamespace(),
        created=False,
    )

    def blocking_start(*_args):
        started.set()
        release.wait(timeout=1)
        return board_team_continuation._BoardTeamContinuationStartOutput(result)

    monkeypatch.setattr(
        board_team_continuation.board_team_continuation_service,
        "_start_nonblocking_sync",
        blocking_start,
    )
    operation = asyncio.create_task(
        board_team_continuation.board_team_continuation_service.start_nonblocking(
            user_id=7,
            request=SimpleNamespace(),
        )
    )
    actual = await _assert_loop_runs_while_blocked(operation, started, release)
    assert actual is result
