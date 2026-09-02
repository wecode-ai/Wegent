# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.services.chat.storage import db as storage_db
from app.services.project_automation_execution import (
    _WegentManagerDispatchIntent,
    project_automation_execution,
)
from app.services.project_automation_managed_execution import (
    ManagedTeamExecutionHandle,
    project_automation_managed_execution_service,
)


@pytest.mark.asyncio
async def test_nonblocking_dispatch_passes_only_scalars_across_async_phase(
    monkeypatch,
) -> None:
    intent = _WegentManagerDispatchIntent(
        run_id="run-1",
        owner_user_id=7,
        team_id=8,
        prompt="Coordinate this issue",
        title="Manager",
        project_id="project-1",
        item_id="issue-1",
        activity_message_id="message-1",
    )
    sync_calls: list[tuple[str, tuple[object, ...]]] = []

    async def run_sync(function, *args):
        sync_calls.append((function.__name__, args))
        if function.__name__ == "_prepare_dispatch_from_store":
            return intent
        return None

    dispatch_managed = AsyncMock(
        return_value=ManagedTeamExecutionHandle(task_id=41, subtask_id=42)
    )
    monkeypatch.setattr(storage_db, "run_sync_in_executor", run_sync)
    monkeypatch.setattr(
        project_automation_managed_execution_service,
        "dispatch_nonblocking",
        dispatch_managed,
    )

    await project_automation_execution.dispatch_nonblocking(run_id="run-1")

    assert sync_calls == [
        ("_prepare_dispatch_from_store", ("run-1",)),
        ("_finish_wegent_manager_dispatch_from_store", (intent, 41, 42)),
    ]
    dispatch_managed.assert_awaited_once_with(
        owner_user_id=7,
        team_id=8,
        prompt="Coordinate this issue",
        title="Manager",
        project_id="project-1",
        loop_item_id="issue-1",
        automation_run_id="run-1",
        project_chat_message_id="message-1",
    )
