# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Ownership contracts for chat side effects detached from Web requests."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.chat import pipeline_advance
from app.services.chat.storage import task_manager
from app.services.openapi import chat_session


def _memory_output() -> task_manager._NonblockingTaskCreationIdsOutput:
    return task_manager._NonblockingTaskCreationIdsOutput(
        creation=task_manager.TaskCreationIds(
            task_id=11,
            user_subtask_id=12,
            assistant_subtask_id=13,
            ai_triggered=True,
        ),
        redis_history=[],
        memory=task_manager._MemorySaveIntent(
            user_id=1,
            team_id=2,
            task_id=11,
            subtask_id=12,
            messages=[{"role": "user", "content": "hello"}],
            workspace_id=None,
            project_id=None,
            is_group_chat=False,
        ),
        group_notification=None,
    )


@pytest.mark.asyncio
async def test_web_memory_save_is_owned_before_its_factory_runs(monkeypatch) -> None:
    owner = SimpleNamespace(submit=AsyncMock())
    save = AsyncMock()
    monkeypatch.setattr(task_manager, "web_background_task_manager", owner)
    monkeypatch.setattr(task_manager, "_save_memory_intent", save)

    await task_manager.run_task_creation_side_effects(
        _memory_output(),
        detach_memory_save=True,
    )

    owner.submit.assert_awaited_once()
    save.assert_not_awaited()
    await owner.submit.await_args.args[0]()
    save.assert_awaited_once()


@pytest.mark.asyncio
async def test_worker_memory_save_is_joined_without_detaching(monkeypatch) -> None:
    owner = SimpleNamespace(submit=AsyncMock())
    save = AsyncMock()
    monkeypatch.setattr(task_manager, "web_background_task_manager", owner)
    monkeypatch.setattr(task_manager, "_save_memory_intent", save)

    await task_manager.run_task_creation_side_effects(_memory_output())

    owner.submit.assert_not_awaited()
    save.assert_awaited_once()


@pytest.mark.asyncio
async def test_openapi_memory_save_uses_nonblocking_owned_admission(
    monkeypatch,
) -> None:
    owner = SimpleNamespace(submit_nowait=Mock())
    memory_manager = SimpleNamespace(
        is_enabled=True,
        save_user_message_async=AsyncMock(),
    )
    monkeypatch.setattr(chat_session, "web_background_task_manager", owner)
    monkeypatch.setattr(
        "app.services.memory.get_memory_manager",
        lambda: memory_manager,
    )
    request = {
        "user_id": "1",
        "team_id": "2",
        "task_id": "11",
        "subtask_id": "12",
        "messages": [{"role": "user", "content": "hello"}],
    }

    chat_session.schedule_memory_save(request)

    owner.submit_nowait.assert_called_once()
    memory_manager.save_user_message_async.assert_not_awaited()
    await owner.submit_nowait.call_args.args[0]()
    memory_manager.save_user_message_async.assert_awaited_once_with(**request)


@pytest.mark.asyncio
async def test_pipeline_web_trigger_is_owned_before_dispatch(monkeypatch) -> None:
    owner = SimpleNamespace(submit=AsyncMock())
    trigger = AsyncMock()
    monkeypatch.setattr(pipeline_advance, "web_background_task_manager", owner)
    monkeypatch.setattr(pipeline_advance, "trigger_ai_response_unified", trigger)

    await pipeline_advance._trigger_next_stage(
        task=SimpleNamespace(id=11),
        team=SimpleNamespace(),
        assistant_subtask=SimpleNamespace(id=13),
        user=SimpleNamespace(),
        message="continue",
        payload=SimpleNamespace(),
        task_room="task:11",
        user_subtask_id=12,
        auth_token="token",
        previous_bot_id=None,
        detach_execution=True,
    )

    owner.submit.assert_awaited_once()
    trigger.assert_not_awaited()
    await owner.submit.await_args.args[0]()
    trigger.assert_awaited_once()
