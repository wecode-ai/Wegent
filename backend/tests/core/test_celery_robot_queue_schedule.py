from app.core.celery_app import celery_app


def test_celery_does_not_hijack_backend_logging() -> None:
    assert celery_app.conf.worker_hijack_root_logger is False
    assert celery_app.conf.worker_redirect_stdouts is False


from app.core.config import settings


def test_robot_queue_scan_expires_before_it_can_form_a_backlog() -> None:
    schedule = celery_app.conf.beat_schedule["scan-robot-queue"]

    assert schedule["schedule"] == float(settings.ROBOT_QUEUE_SCAN_INTERVAL_SECONDS)
    assert schedule["options"] == {
        "expires": float(settings.ROBOT_QUEUE_SCAN_INTERVAL_SECONDS),
        "priority": 0,
    }
