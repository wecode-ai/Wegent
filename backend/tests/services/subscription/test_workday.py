# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Statutory workday planning, configuration, and delayed-dispatch regression tests."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.schemas.subscription import CronTriggerConfig, SubscriptionTriggerType
from app.services.subscription import helpers
from app.services.subscription.service import SubscriptionService
from app.services.subscription.workday import WorkdayCalendarError, is_china_workday
from app.tasks.subscription_tasks import (
    _cancel_non_workday_execution,
    _dispatch_due_subscription,
    execute_subscription_task,
    execute_subscription_task_sync,
)


def freeze_now(monkeypatch, value):
    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return value.astimezone(tz) if tz else value.replace(tzinfo=None)

    monkeypatch.setattr(helpers, "datetime", FrozenDatetime)
    monkeypatch.setattr("app.tasks.subscription_tasks.datetime", FrozenDatetime)


@pytest.mark.parametrize(
    "instant,expected",
    [
        ("2026-10-01T01:00:00+00:00", False),
        ("2026-10-07T01:00:00+00:00", False),
        ("2026-10-10T01:00:00+00:00", True),
        ("2026-10-11T01:00:00+00:00", False),
        ("2026-09-30T17:00:00+00:00", False),
    ],
)
def test_statutory_calendar_uses_china_date(instant, expected):
    assert is_china_workday(datetime.fromisoformat(instant)) is expected


def test_unknown_calendar_year_is_explicit():
    with pytest.raises(WorkdayCalendarError, match="does not cover 2100-01-01"):
        is_china_workday(datetime(2100, 1, 1))


@pytest.mark.parametrize(
    "now,expression,workday_only,expected",
    [
        ("2026-09-30T02:00:00+00:00", "0 9 * * *", True, "2026-10-08T01:00:00"),
        ("2026-10-09T02:00:00+00:00", "0 9 * * *", True, "2026-10-10T01:00:00"),
        ("2026-10-10T02:00:00+00:00", "0 9 * * *", True, "2026-10-12T01:00:00"),
        ("2026-09-30T02:00:00+00:00", "0 9 * * *", False, "2026-10-01T01:00:00"),
        ("2026-10-09T02:00:00+00:00", "0 9 * * 1-5", False, "2026-10-12T01:00:00"),
    ],
)
def test_next_run_includes_makeup_weekends(
    monkeypatch, now, expression, workday_only, expected
):
    freeze_now(monkeypatch, datetime.fromisoformat(now))
    next_run = helpers.calculate_next_execution_time(
        SubscriptionTriggerType.CRON,
        {
            "expression": expression,
            "timezone": "Asia/Shanghai",
            "workday_only": workday_only,
        },
    )
    assert next_run == datetime.fromisoformat(expected)
    assert next_run.tzinfo is None


def test_config_round_trip_retains_workday_flag():
    config = {"expression": "0 9 * * *", "timezone": "UTC", "workday_only": True}
    trigger = helpers.build_trigger_config(SubscriptionTriggerType.CRON, config)
    assert helpers.extract_trigger_config(trigger) == config
    assert CronTriggerConfig(expression="0 9 * * *").workday_only is False


def test_candidate_uses_china_date_when_schedule_timezone_is_utc(monkeypatch):
    freeze_now(monkeypatch, datetime(2026, 9, 30, 15, tzinfo=timezone.utc))
    assert helpers.calculate_next_execution_time(
        SubscriptionTriggerType.CRON,
        {"expression": "0 17 * * *", "timezone": "UTC", "workday_only": True},
    ) == datetime(2026, 10, 7, 17)


@pytest.mark.parametrize("flag", ["false", "true", 1, None])
def test_service_requires_boolean_workday_flag(flag):
    with pytest.raises(HTTPException) as raised:
        SubscriptionService()._validate_trigger_config(
            SubscriptionTriggerType.CRON,
            {"expression": "0 9 * * *", "workday_only": flag},
        )
    assert raised.value.status_code == 400
    assert raised.value.detail == "workday_only must be a boolean"


def test_planning_and_service_reject_unsupported_calendar(monkeypatch):
    freeze_now(monkeypatch, datetime(2100, 1, 1, tzinfo=timezone.utc))
    config = {"expression": "0 9 * * *", "workday_only": True}
    with pytest.raises(WorkdayCalendarError, match="does not cover"):
        helpers.calculate_next_execution_time(SubscriptionTriggerType.CRON, config)
    with pytest.raises(HTTPException) as raised:
        SubscriptionService()._validate_trigger_config(
            SubscriptionTriggerType.CRON, config
        )
    assert raised.value.status_code == 400
    assert "does not cover" in raised.value.detail


@pytest.mark.parametrize("use_sync", [False, True])
@pytest.mark.parametrize(
    "now,should_dispatch,should_advance",
    [
        ("2026-10-01T01:00:00+00:00", False, True),
        ("2026-10-10T01:00:00+00:00", True, True),
        ("2100-01-01T01:00:00+00:00", False, False),
    ],
)
def test_delayed_dispatch_checks_actual_china_day(
    monkeypatch, use_sync, now, should_dispatch, should_advance
):
    freeze_now(monkeypatch, datetime.fromisoformat(now))
    db, service = MagicMock(), MagicMock()
    subscription = SimpleNamespace(id=10, user_id=20, json={})
    crd = SimpleNamespace(
        spec=SimpleNamespace(
            trigger=SimpleNamespace(
                cron=CronTriggerConfig(expression="0 9 * * *", workday_only=True)
            )
        )
    )
    with (
        patch(
            "app.tasks.subscription_tasks.validate_subscription_for_read",
            return_value=crd,
        ),
        patch("app.tasks.subscription_tasks._advance_due_subscription") as advance,
        patch("app.tasks.subscription_tasks._get_trigger_reason", return_value="cron"),
        patch("app.tasks.subscription_tasks._dispatch_scheduled_execution") as dispatch,
    ):
        result = _dispatch_due_subscription(
            db=db,
            subscription=subscription,
            trigger_type="cron",
            subscription_service=service,
            use_sync=use_sync,
        )
    assert result is should_dispatch
    assert service.create_execution.called is should_dispatch
    assert dispatch.called is should_dispatch
    assert advance.called is should_advance
    assert db.rollback.called is (now.startswith("2100"))


def test_unsupported_calendar_keeps_schedule_retryable_after_calendar_update(
    monkeypatch,
):
    freeze_now(monkeypatch, datetime(2100, 1, 1, tzinfo=timezone.utc))
    db, service = MagicMock(), MagicMock()
    stored = {
        "_internal": {"enabled": True, "next_execution_time": "2099-12-31T01:00:00"}
    }
    subscription = SimpleNamespace(id=10, user_id=20, json=stored)
    crd = SimpleNamespace(
        spec=SimpleNamespace(
            trigger=SimpleNamespace(
                cron=CronTriggerConfig(expression="0 9 * * *", workday_only=True)
            )
        )
    )
    with (
        patch(
            "app.tasks.subscription_tasks.validate_subscription_for_read",
            return_value=crd,
        ),
        patch("app.tasks.subscription_tasks._advance_due_subscription") as advance,
        patch("app.tasks.subscription_tasks._get_trigger_reason", return_value="cron"),
        patch("app.tasks.subscription_tasks._dispatch_scheduled_execution") as dispatch,
    ):
        assert not _dispatch_due_subscription(
            db=db,
            subscription=subscription,
            trigger_type="cron",
            subscription_service=service,
            use_sync=False,
        )
        assert subscription.json == stored
        advance.assert_not_called()
        service.create_execution.assert_not_called()
        monkeypatch.setattr(
            "app.services.subscription.workday.is_workday", lambda date: True
        )
        assert _dispatch_due_subscription(
            db=db,
            subscription=subscription,
            trigger_type="cron",
            subscription_service=service,
            use_sync=False,
        )
        dispatch.assert_called_once()


@pytest.mark.parametrize(
    "worker", [execute_subscription_task.run, execute_subscription_task_sync]
)
def test_queued_scheduled_work_is_cancelled_before_task_creation(monkeypatch, worker):
    freeze_now(monkeypatch, datetime(2026, 10, 1, 1, tzinfo=timezone.utc))
    ctx = SimpleNamespace(
        trigger_type="cron",
        execution=SimpleNamespace(id=30, trigger_type="cron"),
        subscription_crd=SimpleNamespace(
            spec=SimpleNamespace(
                trigger=SimpleNamespace(
                    cron=CronTriggerConfig(expression="0 9 * * *", workday_only=True)
                )
            )
        ),
    )
    with (
        patch("app.db.session.get_db_session"),
        patch(
            "app.tasks.subscription_tasks._ensure_subscription_task_event_handlers_registered"
        ),
        patch(
            "app.tasks.subscription_tasks._init_subscription_request_context",
            return_value="test",
        ),
        patch(
            "app.tasks.subscription_tasks._load_subscription_execution_context",
            return_value=ctx,
        ),
        patch("app.tasks.subscription_tasks._generate_task_title") as title,
        patch(
            "app.services.subscription.subscription_service.update_execution_status"
        ) as update,
    ):
        assert worker(10, 30)["status"] == "cancelled"
    title.assert_not_called()
    assert update.call_args.kwargs["status"].value == "CANCELLED"
    assert update.call_args.kwargs["skip_notifications"] is True
    assert "not a China statutory workday" in update.call_args.kwargs["error_message"]


@pytest.mark.parametrize(
    "instant,trigger_type,workday_only",
    [
        ("2026-10-01T01:00:00+00:00", "manual", True),
        ("2026-10-01T01:00:00+00:00", "cron", False),
        ("2026-10-10T01:00:00+00:00", "cron", True),
    ],
)
def test_worker_workday_guard_preserves_manual_and_allowed_execution(
    monkeypatch, instant, trigger_type, workday_only
):
    freeze_now(monkeypatch, datetime.fromisoformat(instant))
    ctx = SimpleNamespace(
        execution=SimpleNamespace(id=30, trigger_type=trigger_type),
        subscription_crd=SimpleNamespace(
            spec=SimpleNamespace(
                trigger=SimpleNamespace(
                    cron=CronTriggerConfig(
                        expression="0 9 * * *", workday_only=workday_only
                    )
                )
            )
        ),
    )
    with patch(
        "app.services.subscription.subscription_service.update_execution_status"
    ) as update:
        assert not _cancel_non_workday_execution(MagicMock(), ctx)
    update.assert_not_called()
