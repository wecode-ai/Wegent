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
from app.core.logging import RequestIdFilter

# Use configured broker/backend or fallback to REDIS_URL
# Settings validator already converts empty strings to None
broker_url = settings.CELERY_BROKER_URL or settings.REDIS_URL
result_backend = settings.CELERY_RESULT_BACKEND or settings.REDIS_URL

celery_app = Celery(
    "wegent",
    broker=broker_url,
    backend=result_backend,
    include=["app.tasks.subscription_tasks"],
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
@after_setup_logger.connect
def setup_celery_logger(logger, *args, **kwargs):
    """
    Configure Celery logger to use backend's log format with request_id.

    This signal handler is called after Celery sets up its logger,
    allowing us to override the format to match backend's format.
    """
    log_format = "%(asctime)s %(levelname)-4s [%(request_id)s] : %(message)s"
    formatter = logging.Formatter(log_format, datefmt="%Y-%m-%d %H:%M:%S")

    # Add RequestIdFilter to all handlers
    for handler in logger.handlers:
        handler.setFormatter(formatter)
        handler.addFilter(RequestIdFilter())


@after_setup_task_logger.connect
def setup_celery_task_logger(logger, *args, **kwargs):
    """
    Configure Celery task logger to use backend's log format with request_id.

    This signal handler is called after Celery sets up its task logger,
    allowing us to override the format to match backend's format.
    """
    log_format = "%(asctime)s %(levelname)-4s [%(request_id)s] : %(message)s"
    formatter = logging.Formatter(log_format, datefmt="%Y-%m-%d %H:%M:%S")

    # Add RequestIdFilter to all handlers
    for handler in logger.handlers:
        handler.setFormatter(formatter)
        handler.addFilter(RequestIdFilter())


# Import dead letter queue handlers to register signal handlers
# This must be done after celery_app is created
import app.core.dead_letter_queue  # noqa: E402, F401
