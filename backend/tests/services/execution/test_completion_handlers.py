# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.core.events import TaskCompletedEvent
from app.services.execution import completion_handlers


@pytest.mark.asyncio
async def test_channel_completion_uses_worker_ipc(monkeypatch) -> None:
    client = AsyncMock()
    monkeypatch.setattr(
        "app.services.channels.worker_client.channel_worker_client",
        client,
    )
    event = TaskCompletedEvent(
        task_id=11,
        subtask_id=22,
        user_id=33,
        status="COMPLETED",
        result={"value": "ok"},
    )

    await completion_handlers._forward_channel_completion(event)

    client.task_completed.assert_awaited_once_with(
        task_id=11,
        subtask_id=22,
        status="COMPLETED",
        content="ok",
        error=None,
    )


@pytest.mark.asyncio
async def test_channel_completion_projects_only_bounded_text(monkeypatch) -> None:
    client = AsyncMock()
    monkeypatch.setattr(
        "app.services.channels.worker_client.channel_worker_client",
        client,
    )
    event = TaskCompletedEvent(
        task_id=11,
        subtask_id=22,
        user_id=33,
        status="FAILED",
        result={"value": "x" * 5000, "blocks": ["not-forwarded"]},
        error="e" * 5000,
    )

    await completion_handlers._forward_channel_completion(event)

    kwargs = client.task_completed.await_args.kwargs
    assert kwargs["content"] == "x" * 4000
    assert kwargs["error"] == "e" * 4000
    assert "result" not in kwargs
