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


def test_dingtalk_sync_runs_daily_at_0200_beijing_time(monkeypatch) -> None:
    monkeypatch.setattr(settings, "SCHEDULED_TASKS_ENABLED", True)
    schedule = build_beat_schedule()["sync-dingtalk-copies"]
    module = "app.tasks.dingtalk_auto_sync_tasks"
    assert module in celery_app.conf.include
    assert schedule["task"] == f"{module}.scan_dingtalk_copies"
    assert schedule["options"] == {"expires": 24 * 60 * 60}

    # Celery evaluates the crontab in UTC: 18:00 UTC is 02:00 Asia/Shanghai.
    cron = schedule["schedule"]
    assert isinstance(cron, crontab)
    assert cron.hour == {18}
    assert cron.minute == {0}
