# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Subscription event handlers must use the worker-backed notification path."""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.subscription.event_handler import SubscriptionEventHandler


@pytest.mark.asyncio
async def test_completion_dispatches_through_store_owned_session() -> None:
    handler = SubscriptionEventHandler(
        subscription_id=3,
        execution_id=4,
        subscription_display_name="Daily",
        team_display_name="Research",
        task_id=5,
        base_url="https://wegent.example/",
    )

    with patch(
        "app.services.subscription.notification_dispatcher."
        "subscription_notification_dispatcher."
        "dispatch_execution_notifications_from_store",
        new=AsyncMock(return_value={}),
    ) as dispatch:
        await handler.on_execution_completed("COMPLETED", "answer")

    dispatch.assert_awaited_once_with(
        subscription_id=3,
        execution_id=4,
        subscription_display_name="Daily (Research)",
        result_summary="回复内容: answer",
        status="COMPLETED",
        detail_url="https://wegent.example/chat?taskId=5",
    )
