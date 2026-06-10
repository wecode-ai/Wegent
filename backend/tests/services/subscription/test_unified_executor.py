# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for subscription unified execution routing."""

import sys
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services.subscription.unified_executor import (
    SubscriptionExecutionData,
    _execute_http_callback,
    execute_subscription_unified,
)


class _FakeEmitter:
    """Minimal emitter stub for dispatcher tests."""

    def __init__(self, task_id: int, subtask_id: int):
        self.task_id = task_id
        self.subtask_id = subtask_id

    async def collect(self):
        return "", None


@pytest.mark.asyncio
async def test_http_callback_dispatch_preserves_device_id():
    """Subscription execution should keep routing to the selected device."""
    execution_data = SubscriptionExecutionData(
        subscription_id=88,
        execution_id=2,
        task_id=544,
        subtask_id=670,
        user_id=2,
        team_id=73,
        user_subtask_id=669,
        device_id="local-device-1",
        prompt="hello",
        model_override_name=None,
        preserve_history=False,
        history_message_count=0,
        subscription_name="echo",
        subscription_display_name="Echo",
        team_display_name="Team",
        trigger_type="cron",
        trigger_reason="Scheduled",
    )

    dispatch_mock = AsyncMock(return_value=None)
    fake_execution_module = SimpleNamespace(
        execution_dispatcher=SimpleNamespace(dispatch=dispatch_mock)
    )
    fake_emitters_module = SimpleNamespace(SSEResultEmitter=_FakeEmitter)

    with (
        patch.dict(
            sys.modules,
            {
                "app.services.execution": fake_execution_module,
                "app.services.execution.emitters": fake_emitters_module,
            },
        ),
    ):
        await _execute_http_callback(request=object(), execution_data=execution_data)

    dispatch_mock.assert_awaited_once()
    _, kwargs = dispatch_mock.await_args
    assert kwargs["device_id"] == "local-device-1"


@pytest.mark.asyncio
async def test_unified_executor_closes_loader_session_before_sse_execution(
    fake_orm_session_factory,
):
    """Long SSE execution must not keep the ORM loading session open."""

    execution_data = SubscriptionExecutionData(
        subscription_id=88,
        execution_id=2,
        task_id=544,
        subtask_id=670,
        user_id=2,
        team_id=73,
        user_subtask_id=669,
        device_id="local-device-1",
        prompt="hello",
        model_override_name=None,
        preserve_history=False,
        history_message_count=0,
        subscription_name="echo",
        subscription_display_name="Echo",
        team_display_name="Team",
        trigger_type="cron",
        trigger_reason="Scheduled",
    )

    fake_session = fake_orm_session_factory(
        task_id=execution_data.task_id,
        assistant_subtask_id=execution_data.subtask_id,
        team_id=execution_data.team_id,
        user_id=execution_data.user_id,
        device_id=execution_data.device_id,
    )

    @contextmanager
    def fake_get_db_session():
        try:
            yield fake_session
        finally:
            fake_session.close()

    async def fake_execute_sse_sync(request, execution_data):
        assert fake_session.rolled_back is True
        assert fake_session.closed is True

    async def fake_build_execution_request(**kwargs):
        assert fake_session.rolled_back is True
        assert fake_session.closed is True
        return object()

    fake_sse_mode = SimpleNamespace(value="SSE")
    fake_execution_module = SimpleNamespace(
        CommunicationMode=SimpleNamespace(SSE=fake_sse_mode),
        ExecutionRouter=lambda: SimpleNamespace(
            route=lambda request, device_id=None: SimpleNamespace(
                mode=fake_sse_mode,
                url="sse://local",
            )
        ),
    )

    with (
        patch.dict(sys.modules, {"app.services.execution": fake_execution_module}),
        patch(
            "app.services.subscription.unified_executor.get_db_session",
            fake_get_db_session,
            create=True,
        ),
        patch(
            "app.services.chat.trigger.unified.build_execution_request",
            AsyncMock(side_effect=fake_build_execution_request),
        ),
        patch(
            "app.services.subscription.unified_executor._execute_sse_sync",
            AsyncMock(side_effect=fake_execute_sse_sync),
        ) as sse_mock,
    ):
        await execute_subscription_unified(execution_data=execution_data)

    sse_mock.assert_awaited_once()
