from app.core.celery_app import build_beat_schedule, celery_app
from app.core.config import settings


def test_robot_queue_scan_expires_before_it_can_form_a_backlog() -> None:
    schedule = celery_app.conf.beat_schedule["scan-robot-queue"]

    assert schedule["schedule"] == float(settings.ROBOT_QUEUE_SCAN_INTERVAL_SECONDS)
    assert schedule["options"] == {
        "expires": float(settings.ROBOT_QUEUE_SCAN_INTERVAL_SECONDS),
        "priority": 0,
    }


def test_knowledge_attachment_orphan_cleanup_is_scheduled() -> None:
    schedule = celery_app.conf.beat_schedule["cleanup-knowledge-attachment-orphans"]

    assert schedule == {
        "task": "app.tasks.knowledge_tasks.cleanup_knowledge_attachment_orphans",
        "schedule": float(settings.KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_INTERVAL_SECONDS),
    }


def test_beat_schedule_is_empty_when_scheduled_tasks_are_disabled(monkeypatch) -> None:
    monkeypatch.setattr(settings, "SCHEDULED_TASKS_ENABLED", False)

    assert build_beat_schedule() == {}
