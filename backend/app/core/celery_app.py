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
from celery.signals import (
    after_setup_logger,
    after_setup_task_logger,
    task_postrun,
    task_prerun,
    worker_process_init,
    worker_process_shutdown,
    worker_shutdown,
    worker_shutting_down,
)

from app.core.config import settings
from app.core.logging import setup_logging, shutdown_logging

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
        "app.tasks.robot_queue_tasks",
        "app.tasks.project_automation_tasks",
        "app.tasks.plugin_marketplace_tasks",
        "app.tasks.video_tasks",
    ],
)

# Celery configuration
celery_app.conf.update(
    # Backend owns the complete logging pipeline. Celery must not replace the
    # root logger or redirect stdout back into logging.
    worker_hijack_root_logger=False,
    worker_redirect_stdouts=False,
    # Serialization
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    # Redis broker behavior
    broker_transport_options={
        "visibility_timeout": settings.CELERY_BROKER_VISIBILITY_TIMEOUT,
    },
    result_backend_transport_options={
        "visibility_timeout": settings.CELERY_BROKER_VISIBILITY_TIMEOUT,
    },
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
    # Task routing - conversion tasks go to dedicated queue
    # knowledge_doc_converter microservice consumes this queue
    task_routes={
        "knowledge_doc_converter.convert_document": {
            "queue": settings.KNOWLEDGE_CONVERSION_QUEUE,
        },
    },
    # Beat schedule for periodic tasks
    beat_schedule={
        "check-due-subscriptions": {
            "task": "app.tasks.subscription_tasks.check_due_subscriptions",
            "schedule": float(settings.FLOW_SCHEDULER_INTERVAL_SECONDS),
        },
        "scan-robot-queue": {
            "task": "app.tasks.robot_queue_tasks.scan_robot_queue",
            "schedule": float(settings.ROBOT_QUEUE_SCAN_INTERVAL_SECONDS),
            "options": {
                # A maintenance scan older than one interval has been replaced
                # by a newer scan and must not delay execution tasks.
                "expires": float(settings.ROBOT_QUEUE_SCAN_INTERVAL_SECONDS),
                "priority": 0,
            },
        },
        "check-due-project-automations": {
            "task": "app.tasks.project_automation_tasks.check_due_project_automations",
            "schedule": float(settings.FLOW_SCHEDULER_INTERVAL_SECONDS),
        },
        "scan-stale-index-tasks": {
            "task": "app.tasks.knowledge_tasks.scan_stale_index_tasks",
            "schedule": 5 * 60,  # every 5 minutes
        },
        "sync-plugin-upstreams": {
            "task": "app.tasks.plugin_marketplace_tasks.sync_plugin_upstreams",
            "schedule": 6 * 60 * 60,
        },
    },
    # Beat scheduler class - Use default PersistentScheduler (file-based)
    # Note: Only run ONE Celery Beat instance in production
    # Application-level distributed lock in check_due_subscriptions prevents duplicate execution
    beat_scheduler="celery.beat:PersistentScheduler",
)


def _apply_backend_format(logger: logging.Logger) -> None:
    """Route Celery logs through the process-local nonblocking root handler."""
    setup_logging()
    root_logger = logging.getLogger()
    if logger is root_logger:
        return
    logger.handlers.clear()
    logger.propagate = True


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


@worker_process_init.connect
def setup_celery_child_logging(*args, **kwargs):
    """Create an independent queue and listener in each prefork child."""
    setup_logging()


@worker_process_shutdown.connect
def shutdown_celery_child_logging(*args, **kwargs):
    """Bound shutdown latency while giving queued child logs time to drain."""
    shutdown_logging()


@task_prerun.connect
def clear_stale_request_context_before_task(*args, **kwargs):
    """Prevent a worker thread from leaking request IDs between Celery tasks."""
    from shared.telemetry.context import set_request_context

    set_request_context("")


@task_postrun.connect
def clear_request_context_after_task(*args, **kwargs):
    """Clear request context after task completion or retry."""
    from shared.telemetry.context import set_request_context

    set_request_context("")


@worker_shutting_down.connect
@worker_shutdown.connect
def mark_celery_worker_local_shutdown(*args, **kwargs):
    """Mark this Celery worker process as shutting down."""
    from app.core.local_shutdown import mark_local_shutdown

    mark_local_shutdown()
    logging.getLogger(__name__).info("Marked Celery worker local shutdown")


# Import dead letter queue handlers to register signal handlers
# This must be done after celery_app is created
import app.core.dead_letter_queue  # noqa: E402, F401
