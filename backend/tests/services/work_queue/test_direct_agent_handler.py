# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import sys
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.kind import ModelRef
from app.schemas.work_queue import AutoProcessConfig, TeamRef
from app.services.chat.storage.task_manager import TaskCreationResult
from app.services.inbox.direct_agent_handler import InboxDirectAgentHandler
from shared.models.db.enums import TriggerMode


async def _wait_for_thread(started: threading.Event) -> None:
    while not started.is_set():
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_handle_passes_model_override_to_created_task():
    handler = InboxDirectAgentHandler()
    event = SimpleNamespace(message_id=11, queue_id=3)
    auto_process = AutoProcessConfig(
        enabled=True,
        mode="direct_agent",
        triggerMode=TriggerMode.IMMEDIATE,
        teamRef=TeamRef(name="queue-team", namespace="default"),
        modelRef=ModelRef(name="gpt-5", namespace="default"),
        forceOverrideBotModel=True,
    )
    from app.services.chat.storage.task_manager import TaskCreationParams

    params = TaskCreationParams(
        message="queue message",
        model_id="gpt-5",
        force_override_bot_model=True,
        force_override_bot_model_type="public",
        task_type="chat",
    )
    plan = SimpleNamespace(
        message_id=11,
        user_id=7,
        team_id=17,
        message="queue message",
        params=params,
    )

    create_task_result = TaskCreationResult(
        task=SimpleNamespace(id=123),
        user_subtask=SimpleNamespace(id=456),
        assistant_subtask=SimpleNamespace(id=789),
        ai_triggered=True,
    )

    with (
        patch.object(handler, "_prepare_direct_agent_sync", return_value=plan),
        patch.object(handler, "_persist_created_task_sync"),
        patch.object(handler, "_register_task_completion_listener"),
        patch.object(handler, "_dispatch_ai_execution", new_callable=AsyncMock),
        patch(
            "app.services.chat.storage.task_manager.create_chat_task_nonblocking",
            new_callable=AsyncMock,
            return_value=create_task_result,
        ) as mock_create_chat_task,
    ):
        await handler.handle(event=event, auto_process=auto_process)

    params = mock_create_chat_task.await_args.kwargs["params"]
    assert params.model_id == "gpt-5"
    assert params.force_override_bot_model is True
    assert params.force_override_bot_model_type == "public"


@pytest.mark.asyncio
async def test_handle_preparation_does_not_block_event_loop():
    handler = InboxDirectAgentHandler()
    event = SimpleNamespace(message_id=11, queue_id=3)
    auto_process = AutoProcessConfig(
        enabled=True,
        mode="direct_agent",
        triggerMode=TriggerMode.IMMEDIATE,
        teamRef=TeamRef(name="queue-team", namespace="default"),
    )
    started = threading.Event()
    release = threading.Event()

    def blocking_prepare(*_args):
        started.set()
        release.wait()
        return None

    safety_release = threading.Timer(2, release.set)
    safety_release.start()
    try:
        with patch.object(
            handler,
            "_prepare_direct_agent_sync",
            side_effect=blocking_prepare,
        ):
            handling = asyncio.create_task(handler.handle(event, auto_process))
            await asyncio.wait_for(_wait_for_thread(started), timeout=0.5)
            assert not handling.done()
            release.set()
            await handling
    finally:
        release.set()
        safety_release.cancel()


@pytest.mark.asyncio
async def test_handle_marks_message_failed_when_async_dispatch_cannot_start():
    handler = InboxDirectAgentHandler()
    event = SimpleNamespace(message_id=11, queue_id=3)
    auto_process = AutoProcessConfig(
        enabled=True,
        mode="direct_agent",
        triggerMode=TriggerMode.IMMEDIATE,
        teamRef=TeamRef(name="queue-team", namespace="default"),
    )
    from app.services.chat.storage.task_manager import TaskCreationParams

    plan = SimpleNamespace(
        message_id=11,
        user_id=7,
        team_id=17,
        message="queue message",
        params=TaskCreationParams(message="queue message", task_type="chat"),
    )
    result = TaskCreationResult(
        task=SimpleNamespace(id=123),
        user_subtask=SimpleNamespace(id=456),
        assistant_subtask=SimpleNamespace(id=789),
        ai_triggered=True,
    )

    with (
        patch.object(handler, "_prepare_direct_agent_sync", return_value=plan),
        patch.object(handler, "_persist_created_task_sync"),
        patch.object(handler, "_register_task_completion_listener"),
        patch.object(
            handler,
            "_dispatch_ai_execution",
            new=AsyncMock(side_effect=RuntimeError("dispatcher unavailable")),
        ),
        patch.object(handler, "_mark_failed_by_id_sync") as mark_failed,
        patch(
            "app.services.chat.storage.task_manager.create_chat_task_nonblocking",
            new=AsyncMock(return_value=result),
        ),
    ):
        await handler.handle(event, auto_process)

    mark_failed.assert_called_once_with(
        11,
        "AI dispatch failed: dispatcher unavailable",
    )


def test_resolve_model_override_uses_public_model_type_for_public_model():
    handler = InboxDirectAgentHandler()
    db = MagicMock()
    owner = SimpleNamespace(id=7)
    auto_process = AutoProcessConfig(
        enabled=True,
        mode="direct_agent",
        triggerMode=TriggerMode.IMMEDIATE,
        teamRef=TeamRef(name="queue-team", namespace="default"),
        modelRef=ModelRef(name="gpt-5", namespace="default"),
        forceOverrideBotModel=True,
    )

    with patch(
        "app.services.inbox.direct_agent_handler.kindReader.get_by_name_and_namespace",
        return_value=SimpleNamespace(user_id=0, namespace="default"),
        create=True,
    ):
        model_name, force_override, model_type = handler._resolve_model_override(
            db=db,
            owner=owner,
            auto_process=auto_process,
        )

    assert model_name == "gpt-5"
    assert force_override is True
    assert model_type == "public"


@pytest.mark.asyncio
async def test_dispatch_ai_execution_builds_request_from_scalar_identities():
    handler = InboxDirectAgentHandler()

    class FakeEmitter:
        def __init__(self, task_id: int, subtask_id: int):
            self.task_id = task_id
            self.subtask_id = subtask_id

        async def collect(self):
            return "", None

    dispatch_mock = AsyncMock(return_value=None)
    fake_execution_module = SimpleNamespace(
        execution_dispatcher=SimpleNamespace(dispatch=dispatch_mock)
    )
    fake_emitters_module = SimpleNamespace(SSEResultEmitter=FakeEmitter)

    async def fake_build_execution_request(**kwargs):
        assert kwargs["task"] == 123
        assert kwargs["assistant_subtask"] == 789
        assert kwargs["team"] == 17
        assert kwargs["user"] == 7
        return object()

    with (
        patch(
            "app.services.chat.trigger.unified.build_execution_request",
            AsyncMock(side_effect=fake_build_execution_request),
        ),
        patch.dict(
            sys.modules,
            {
                "app.services.execution": fake_execution_module,
                "app.services.execution.emitters": fake_emitters_module,
            },
        ),
    ):
        await handler._dispatch_ai_execution(
            task_id=123,
            assistant_subtask_id=789,
            team_id=17,
            user_id=7,
            message="hello",
            user_subtask_id=456,
        )

    dispatch_mock.assert_awaited_once()
