# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Celery application configuration for Subscription Scheduler.

This module configures Celery for distributed task execution,
separating trigger from execution to enable parallel processing
and avoid blocking the scheduler.

Features:
- Distributed task queue with Redis broker
- PersistentScheduler for periodic tasks (file-based, single-instance)
- Dead letter queue for failed tasks (via signals)
- Circuit breaker for external service calls
- Application-level distributed lock to prevent duplicate task execution

Beat Scheduler Storage:
- PersistentScheduler (default): Uses local file for schedule storage
  - Simple and reliable for single-instance deployment
  - Application-level distributed lock prevents duplicate execution across workers
  - No external dependencies beyond Redis for locking
"""

import logging

from celery import Celery
from celery.signals import after_setup_logger, after_setup_task_logger

from app.core.config import settings
from app.core.logging import RequestIdFilter, _create_file_handler

# Use configured broker/backend or fallback to REDIS_URL
# Settings validator already converts empty strings to None
broker_url = settings.CELERY_BROKER_URL or settings.REDIS_URL
result_backend = settings.CELERY_RESULT_BACKEND or settings.REDIS_URL

celery_app = Celery(
    "wegent",
    broker=broker_url,
    backend=result_backend,
    include=[
        "app.tasks.subscription_tasks",
        "app.tasks.knowledge_tasks",
    ],
)

# Celery configuration
celery_app.conf.update(
    # Serialization
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    # Timezone
    timezone="UTC",
    enable_utc=True,
    # Task execution
    task_time_limit=settings.FLOW_DEFAULT_TIMEOUT_SECONDS + 60,  # Hard limit
    task_soft_time_limit=settings.FLOW_DEFAULT_TIMEOUT_SECONDS,  # Soft limit for graceful handling
    worker_prefetch_multiplier=1,  # Fair scheduling, one task at a time per worker
    task_acks_late=True,  # Acknowledge after execution for reliability
    task_reject_on_worker_lost=True,  # Requeue tasks if worker crashes
    # Result backend
    result_expires=3600,  # Results expire after 1 hour
    # Retry settings
    task_default_retry_delay=60,  # 1 minute default retry delay
    # Default queue configuration
    task_default_queue=settings.CELERY_TASK_DEFAULT_QUEUE,
    # Beat schedule for periodic tasks
    beat_schedule={
        "check-due-subscriptions": {
            "task": "app.tasks.subscription_tasks.check_due_subscriptions",
            "schedule": float(settings.FLOW_SCHEDULER_INTERVAL_SECONDS),
        },
    },
    # Beat scheduler class - Use default PersistentScheduler (file-based)
    # Note: Only run ONE Celery Beat instance in production
    # Application-level distributed lock in check_due_subscriptions prevents duplicate execution
    beat_scheduler="celery.beat:PersistentScheduler",
)


# Configure Celery logging to use the same format as backend (with request_id)
def _apply_backend_format(logger: logging.Logger) -> None:
    """
    Apply backend log format to all existing handlers of *logger*,
    then attach a TimedRotatingFileHandler so that logs are also
    written to the shared log file (same as uvicorn workers).

    Celery rebuilds logger handlers via its own signals, so the file
    handler added by setup_logging() would be lost without this call.
    """
    log_format = (
        "%(asctime)s %(levelname)-4s [%(request_id)s] "
        "%(pathname)s:%(lineno)d : %(message)s"
    )
    datefmt = "%Y-%m-%d %H:%M:%S"
    formatter = logging.Formatter(log_format, datefmt=datefmt)

    # Re-format existing (console) handlers
    for handler in logger.handlers:
        handler.setFormatter(formatter)
        handler.addFilter(RequestIdFilter())

    # Attach file handler if enabled and not already present
    if settings.LOG_FILE_ENABLED:
        from app.core.logging import HourlyRotatingFileHandler

        already_has_file = any(
            isinstance(h, HourlyRotatingFileHandler) for h in logger.handlers
        )
        if not already_has_file:
            file_handler = _create_file_handler(log_format, datefmt)
            if file_handler is not None:
                logger.addHandler(file_handler)


@after_setup_logger.connect
def setup_celery_logger(logger, *args, **kwargs):
    """
    Configure Celery logger to use backend's log format with request_id
    and write to the rotating log file.
    """
    _apply_backend_format(logger)


@after_setup_task_logger.connect
def setup_celery_task_logger(logger, *args, **kwargs):
    """
    Configure Celery task logger to use backend's log format with request_id
    and write to the rotating log file.
    """
    _apply_backend_format(logger)


# Import dead letter queue handlers to register signal handlers
# This must be done after celery_app is created
import app.core.dead_letter_queue  # noqa: E402, F401
