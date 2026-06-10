# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services.background_chat_executor import (
    BackgroundChatExecutor,
    BackgroundTaskConfig,
)


class _TrackingSession:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True

    def commit(self):
        pass


@pytest.mark.asyncio
async def test_short_session_executor_closes_db_before_sse_wait():
    sessions = []

    def session_factory():
        session = _TrackingSession()
        sessions.append(session)
        return session

    executor = BackgroundChatExecutor.with_short_sessions(
        user_id=10,
        session_factory=session_factory,
    )

    task = SimpleNamespace(id=1)
    assistant_subtask = SimpleNamespace(id=2)

    class FakeEmitter:
        def __init__(self, task_id, subtask_id):
            self.task_id = task_id
            self.subtask_id = subtask_id

        async def collect(self):
            assert sessions[0].closed is True
            return '{"short_summary":"ok"}', None

    with (
        patch.object(
            executor,
            "_create_task_records_in_db",
            return_value=(task, SimpleNamespace(id=1), assistant_subtask),
        ),
        patch.object(
            executor,
            "_load_task_records",
            return_value=(SimpleNamespace(json={"status": {}}), SimpleNamespace()),
        ),
        patch.object(executor, "_mark_task_completed"),
        patch(
            "app.services.execution.emitters.SSEResultEmitter",
            return_value=FakeEmitter(task_id=1, subtask_id=2),
        ),
        patch(
            "app.services.background_chat_executor.execution_dispatcher.dispatch",
            new_callable=AsyncMock,
        ) as mock_dispatch,
    ):
        result = await executor.execute(
            system_prompt="system",
            user_message="message",
            config=BackgroundTaskConfig(
                task_type="summary",
                summary_type="document",
                document_id=3,
                model_config={"model_name": "model-a"},
            ),
        )

    assert result.success is True
    assert len(sessions) == 2
    assert sessions[0].closed is True
    assert sessions[1].closed is True
    mock_dispatch.assert_awaited_once()
