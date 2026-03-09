# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for subscription unified execution routing."""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.subscription.unified_executor import (
    SubscriptionExecutionData,
    _execute_http_callback,
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

    with (
        patch(
            "app.services.execution.execution_dispatcher.dispatch",
            dispatch_mock,
        ),
        patch(
            "app.services.execution.emitters.SSEResultEmitter",
            _FakeEmitter,
        ),
    ):
        await _execute_http_callback(request=object(), execution_data=execution_data)

    dispatch_mock.assert_awaited_once()
    _, kwargs = dispatch_mock.await_args
    assert kwargs["device_id"] == "local-device-1"
