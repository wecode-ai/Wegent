# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Memory writes must survive chat creation and retain their independent window."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.services.chat.storage import task_manager


@pytest.mark.asyncio
@pytest.mark.parametrize("history_window", [None, 0, 1, 20])
@pytest.mark.parametrize("memory_context_messages", [1, 3, 100])
async def test_chat_creation_saves_independent_memory_history(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    history_window: int | None,
    memory_context_messages: int,
) -> None:
    # Arrange real task/history persistence and mock external memory/Redis only.
    bot = Kind(
        id=1255,
        kind="Bot",
        user_id=test_user.id,
        name="memory-bot",
        namespace="default",
        json={},
    )
    test_db.add(bot)
    test_db.flush()
    team = SimpleNamespace(
        json={
            "metadata": {"name": "quickstart", "namespace": "default"},
            "spec": {
                "members": [{"botRef": {"name": bot.name}}],
                "collaborationModel": "solo",
            },
        },
        id=1256,
        user_id=test_user.id,
        name="quickstart",
        namespace="default",
    )
    monkeypatch.setattr(
        task_manager, "build_initial_task_knowledge_base_refs", lambda *args, **kw: []
    )
    monkeypatch.setattr(settings, "MEMORY_CONTEXT_MESSAGES", memory_context_messages)
    task = task_manager.create_new_task(
        test_db, test_user, team, task_manager.TaskCreationParams(message="initial")
    )
    task.json = {**task.json, "status": {"status": "COMPLETED"}}
    for message_id in range(1, 107):
        test_db.add(
            Subtask(
                task_id=task.id,
                user_id=test_user.id,
                team_id=team.id,
                title=f"history-{message_id}",
                bot_ids=[1255],
                role=(SubtaskRole.USER if message_id % 2 else SubtaskRole.ASSISTANT),
                message_id=message_id,
                parent_id=message_id - 1,
                status=(
                    SubtaskStatus.COMPLETED
                    if message_id <= 104
                    else SubtaskStatus.CANCELLED
                ),
                prompt=f"prompt-{message_id}",
                result={"value": f"answer-{message_id}"},
            )
        )
    test_db.commit()
    saved = asyncio.Event()
    save = AsyncMock(side_effect=lambda **kwargs: saved.set())
    monkeypatch.setattr(
        "app.services.memory.get_memory_manager",
        lambda: SimpleNamespace(is_enabled=True, save_user_message_async=save),
    )
    monkeypatch.setattr(
        "app.services.memory.is_memory_enabled_for_user", lambda _user: True
    )
    initialize_history = AsyncMock()
    monkeypatch.setattr(
        task_manager, "initialize_redis_chat_history", initialize_history
    )

    # Act through the full chat creation flow with long-term memory enabled.
    result = await task_manager.create_task_and_subtasks(
        db=test_db,
        user=test_user,
        team=team,
        message="current-message",
        params=task_manager.TaskCreationParams(
            message="current-message", history_window=history_window
        ),
        task_id=task.id,
    )
    await asyncio.wait_for(saved.wait(), timeout=1)

    # Assert memory content, chronology, and downstream chat initialization.
    history_count = memory_context_messages - 1
    memory_ids = (
        list(range(1, history_count + 1))[::-1]
        if history_window is None
        else list(range(105 - history_count, 105))
    )
    expected_messages = [
        {
            "role": "user" if message_id % 2 else "assistant",
            "content": (
                f"prompt-{message_id}" if message_id % 2 else f"answer-{message_id}"
            ),
        }
        for message_id in memory_ids
    ] + [{"role": "user", "content": "current-message"}]
    save.assert_awaited_once()
    assert save.await_args.kwargs["messages"] == expected_messages
    assert len(expected_messages) == memory_context_messages
    assert save.await_args.kwargs["subtask_id"] == str(result.user_subtask.id)
    assert result.user_subtask.message_id == 107
    assert result.assistant_subtask.message_id == 108
    if history_window == 0:
        initialize_history.assert_not_awaited()
    else:
        initialize_history.assert_awaited_once()
        expected_count = 106 if history_window is None else history_window
        assert len(initialize_history.await_args.args[1]) == expected_count
