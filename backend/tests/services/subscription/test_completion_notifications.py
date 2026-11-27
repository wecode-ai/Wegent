# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.core.events import TaskCompletedEvent
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.user import User
from app.services.subscription import execution, task_completion_handler
from app.services.subscription.task_completion_handler import (
    SubscriptionTaskCompletionHandler,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "error", "summary", "expected"),
    [
        (
            "FAILED",
            "JSON message exceeded maximum buffer size of 1048576 bytes",
            "I will start multiple search agents in parallel.",
            "JSON message exceeded maximum buffer size of 1048576 bytes",
        ),
        (
            "FAILED",
            None,
            "I will start searching.",
            "Execution failed; no error details were provided.",
        ),
        (
            "FAILED",
            "  ",
            "I will start searching.",
            "Execution failed; no error details were provided.",
        ),
        ("FAILED", "  actual error  ", None, "actual error"),
        ("COMPLETED", None, "Complete briefing", "Complete briefing"),
        ("COMPLETED", "stale error", "Complete briefing", "Complete briefing"),
        ("COMPLETED", None, None, ""),
    ],
)
async def test_completion_notifications_use_error_only_for_failed_executions(
    status: str, error: str | None, summary: str | None, expected: str
) -> None:
    handler = SubscriptionTaskCompletionHandler()
    execution = SimpleNamespace(id=11, subscription_id=22, status=status)
    event = TaskCompletedEvent(
        task_id=44,
        subtask_id=33,
        user_id=1,
        status=status,
        result={"value": summary},
        error=error,
    )
    subscription = SimpleNamespace(name="daily-briefing", json={})
    subscription_crd = SimpleNamespace(
        spec=SimpleNamespace(
            displayName="Daily Briefing",
            teamRef=None,
            notificationWebhooks=[{"type": "dingtalk", "url": "https://example.test"}],
        )
    )
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = subscription
    module = "app.services.subscription.task_completion_handler"

    with (
        patch(
            f"{module}.validate_subscription_for_read", return_value=subscription_crd
        ),
        patch(
            f"{module}.subscription_notification_dispatcher.dispatch_execution_notifications",
            new_callable=AsyncMock,
        ) as follower_notifications,
        patch(
            f"{module}.subscription_notification_dispatcher.dispatch_webhook_notifications",
            new_callable=AsyncMock,
        ) as webhook_notifications,
    ):
        await handler._dispatch_notifications(db, execution, event, summary)

    for dispatcher in (follower_notifications, webhook_notifications):
        dispatcher.assert_awaited_once()
        assert dispatcher.await_args.kwargs["result_summary"] == expected
        assert dispatcher.await_args.kwargs["status"] == status
    # Notification formatting must not replace the partial output kept for diagnosis.
    assert event.result == {"value": summary}
    assert event.error == error


@pytest.mark.asyncio
async def test_completion_sends_webhook_after_cleanup_commit_fails(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    handler = SubscriptionTaskCompletionHandler()
    dispatcher = task_completion_handler.subscription_notification_dispatcher
    send_webhook = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(dispatcher, "_send_webhook_notification", send_webhook)
    monkeypatch.setattr(execution, "emit_background_execution_update", MagicMock())

    with Session(
        bind=test_db.get_bind(), join_transaction_mode="create_savepoint"
    ) as db:
        subscription = Kind(
            user_id=test_user.id,
            kind="Subscription",
            name="daily-briefing",
            namespace="default",
            json={
                "metadata": {"name": "daily-briefing"},
                "spec": {
                    "displayName": "Daily Briefing",
                    "trigger": {"type": "interval"},
                    "teamRef": {"name": "briefing-team"},
                    "promptTemplate": "Prepare a briefing",
                    "notificationWebhooks": [
                        {"type": "dingtalk", "url": "https://example.test"}
                    ],
                },
            },
        )
        db.add(subscription)
        db.flush()
        run = BackgroundExecution(
            user_id=test_user.id,
            subscription_id=subscription.id,
            task_id=44,
            trigger_type="interval",
            prompt="Prepare a briefing",
            status="RUNNING",
        )
        db.add(run)
        db.commit()

        async def fail_cleanup_commit(
            cleanup_db: Session, _task_id: int, _source: str
        ) -> None:
            subscription.name = None
            cleanup_db.commit()

        monkeypatch.setattr(handler, "_cleanup_task_runtime", fail_cleanup_commit)
        monkeypatch.setattr(
            task_completion_handler, "get_db_session", lambda: nullcontext(db)
        )

        await handler.on_task_completed(
            TaskCompletedEvent(
                task_id=44,
                subtask_id=33,
                user_id=test_user.id,
                status="COMPLETED",
                result={"value": "Complete briefing"},
            )
        )

        send_webhook.assert_awaited_once()
        assert send_webhook.await_args.kwargs["webhook"].type.value == "dingtalk"
        assert send_webhook.await_args.kwargs["result_summary"] == "Complete briefing"
        assert run.status == "COMPLETED"
        assert subscription.name == "daily-briefing"
