# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Completion logs must record the summary length, never the summary body."""

import logging
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.subscription import BackgroundExecution
from app.models.user import User
from app.schemas.subscription import BackgroundExecutionStatus
from app.services.subscription import notification_dispatcher
from app.services.subscription.execution import background_execution_manager

BODY_MARKER = "SUMMARY-BODY-MUST-NOT-BE-LOGGED"
# The status-change line keeps a 50-character preview, so the marker sits far
# beyond it: finding the marker in the logs means the whole body was written.
LARGE_SUMMARY = "x" * 20_000 + BODY_MARKER


def test_update_execution_status_logs_summary_length_on_completion(
    test_db: Session, test_user: User, caplog: pytest.LogCaptureFixture
) -> None:
    # Arrange
    execution = BackgroundExecution(
        user_id=test_user.id,
        subscription_id=1,
        task_id=0,
        trigger_type="manual",
        trigger_reason="Test",
        prompt="Test prompt",
        status=BackgroundExecutionStatus.RUNNING.value,
        retry_attempt=0,
    )
    test_db.add(execution)
    test_db.commit()
    test_db.refresh(execution)

    # Act
    with (
        patch("app.services.subscription.execution.emit_background_execution_update"),
        patch.object(
            background_execution_manager, "_dispatch_completion_notifications"
        ) as dispatch,
        caplog.at_level(logging.DEBUG, logger="app.services.subscription.execution"),
    ):
        updated = background_execution_manager.update_execution_status(
            test_db,
            execution_id=execution.id,
            status=BackgroundExecutionStatus.COMPLETED,
            result_summary=LARGE_SUMMARY,
        )

    # Assert
    assert updated is True
    dispatch.assert_called_once()
    expected = f"summary_chars={len(LARGE_SUMMARY)}"
    messages = [record.getMessage() for record in caplog.records]
    emitting = [m for m in messages if "Emitting WS event" in m]
    dispatching = [m for m in messages if "Dispatching completion notifications" in m]
    assert len(emitting) == 1 and expected in emitting[0]
    assert len(dispatching) == 1 and expected in dispatching[0]
    assert BODY_MARKER not in caplog.text


@pytest.mark.asyncio
async def test_dispatch_execution_notifications_logs_summary_length(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # Arrange
    monkeypatch.setattr(
        notification_dispatcher.subscription_notification_service,
        "get_followers_with_settings",
        lambda db, subscription_id: [],
    )
    dispatcher = notification_dispatcher.SubscriptionNotificationDispatcher()

    # Act
    with caplog.at_level(logging.INFO, logger=notification_dispatcher.__name__):
        await dispatcher.dispatch_execution_notifications(
            MagicMock(),
            subscription_id=22,
            execution_id=11,
            subscription_display_name="Daily Briefing",
            result_summary=LARGE_SUMMARY,
            status="COMPLETED",
        )

    # Assert
    assert f"summary_chars={len(LARGE_SUMMARY)}" in caplog.text
    assert BODY_MARKER not in caplog.text


@pytest.mark.asyncio
async def test_dingtalk_webhook_request_log_omits_markdown_text(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # Arrange
    sent_payloads = []

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"errcode": 0}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, json):
            sent_payloads.append(json)
            return FakeResponse()

    monkeypatch.setattr(
        notification_dispatcher.httpx, "AsyncClient", lambda **_kwargs: FakeClient()
    )
    dispatcher = notification_dispatcher.SubscriptionNotificationDispatcher()

    # Act
    with caplog.at_level(logging.INFO, logger=notification_dispatcher.__name__):
        result = await dispatcher._send_dingtalk_webhook(
            url="https://example.test/robot/send?access_token=test",
            secret=None,
            subscription_display_name="Daily Briefing",
            result_summary=LARGE_SUMMARY,
            status="COMPLETED",
        )

    # Assert
    assert result == {"success": True}
    sent_text = sent_payloads[0]["markdown"]["text"]
    assert BODY_MARKER in sent_text
    assert f"Payload text chars: {len(sent_text)}" in caplog.text
    assert BODY_MARKER not in caplog.text
