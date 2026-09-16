from celery.schedules import crontab

from app.core.celery_app import build_beat_schedule, celery_app
from app.core.config import settings


def test_robot_queue_scan_expires_before_it_can_form_a_backlog() -> None:
    schedule = celery_app.conf.beat_schedule["scan-robot-queue"]

    assert schedule["schedule"] == float(settings.ROBOT_QUEUE_SCAN_INTERVAL_SECONDS)
    assert schedule["options"] == {
        "expires": float(settings.ROBOT_QUEUE_SCAN_INTERVAL_SECONDS),
        "priority": 0,
    }


def test_beat_schedule_is_empty_when_scheduled_tasks_are_disabled(monkeypatch) -> None:
    monkeypatch.setattr(settings, "SCHEDULED_TASKS_ENABLED", False)

    assert build_beat_schedule() == {}


def test_dingtalk_sync_runs_daily_at_configured_utc_time(monkeypatch) -> None:
    monkeypatch.setattr(settings, "SCHEDULED_TASKS_ENABLED", True)
    schedule = build_beat_schedule()["sync-dingtalk-copies"]
    module = "app.tasks.dingtalk_auto_sync_tasks"
    assert module in celery_app.conf.include
    assert schedule["task"] == f"{module}.scan_dingtalk_copies"
    assert schedule["options"] == {"expires": 24 * 60 * 60}

    # Celery evaluates the crontab in UTC; the default 18:00 UTC is 02:00 CST.
    cron = schedule["schedule"]
    assert isinstance(cron, crontab)
    assert cron.hour == {settings.DINGTALK_SYNC_HOUR_UTC}
    assert cron.minute == {settings.DINGTALK_SYNC_MINUTE_UTC}

    monkeypatch.setattr(settings, "DINGTALK_SYNC_HOUR_UTC", 3)
    monkeypatch.setattr(settings, "DINGTALK_SYNC_MINUTE_UTC", 30)

    configured = build_beat_schedule()["sync-dingtalk-copies"]["schedule"]
    assert configured.hour == {3}
    assert configured.minute == {30}
