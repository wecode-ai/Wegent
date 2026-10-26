# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.tasks import subscription_completion_tasks as tasks

pytestmark = pytest.mark.unit


@pytest.mark.parametrize("status", [None, "RUNNING", "CANCELLED", "COMPLETED_SILENT"])
def test_notifications_require_a_notifiable_committed_terminal_result(
    monkeypatch, status: str | None
) -> None:
    db = MagicMock()
    db.get.return_value = SimpleNamespace(status=status) if status else None

    @contextmanager
    def session():
        yield db

    handler = MagicMock()
    monkeypatch.setattr(tasks, "get_db_session", session)
    monkeypatch.setattr(tasks, "SubscriptionTaskCompletionHandler", handler)

    tasks.notify_execution.run(execution_id=11)

    handler.assert_not_called()


@pytest.mark.parametrize("status", ["COMPLETED", "FAILED"])
def test_notifications_reuse_channel_dispatch_without_replaying_completion(
    monkeypatch, status: str
) -> None:
    db = MagicMock()
    execution = SimpleNamespace(
        id=11,
        user_id=7,
        task_id=42,
        status=status,
        result_summary="partial output",
        error_message="provider failed" if status == "FAILED" else "",
    )
    db.get.return_value = execution

    @contextmanager
    def session():
        yield db

    handler = MagicMock()
    handler._is_code_wiki_scheduled_update.return_value = False
    handler._dispatch_notifications = AsyncMock()
    monkeypatch.setattr(tasks, "get_db_session", session)
    monkeypatch.setattr(tasks, "SubscriptionTaskCompletionHandler", lambda: handler)

    tasks.notify_execution.run(execution_id=11)

    handler._dispatch_notifications.assert_awaited_once()
    args = handler._dispatch_notifications.call_args.args
    assert args[0] is db
    assert args[1] is execution
    assert args[2].task_id == 42
    assert args[2].status == status
    assert args[2].error == (execution.error_message or None)
    assert args[3] == "partial output"
    handler.on_task_completed.assert_not_called()
    handler.execution_manager.update_execution_status.assert_not_called()
    handler._cleanup_task_runtime.assert_not_called()


def test_completion_notification_worker_is_registered() -> None:
    assert "app.tasks.subscription_completion_tasks" in tasks.celery_app.conf.include
    assert tasks.notify_execution.name == (
        "app.tasks.subscription_completion_tasks.notify_execution"
    )
