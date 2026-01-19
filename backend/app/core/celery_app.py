# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Celery application configuration for Flow Scheduler.

This module configures Celery for distributed task execution,
separating trigger from execution to enable parallel processing
and avoid blocking the scheduler.

Features:
- Distributed task queue with Redis broker
- RedBeat scheduler for periodic tasks (Redis-based, distributed-ready)
- Dead letter queue for failed tasks (via signals)
- Circuit breaker for external service calls

Beat Scheduler Storage:
- RedBeat (default): Uses Redis for schedule storage, suitable for distributed deployment
  - Automatically handles multi-instance coordination
  - No database migrations needed
  - Simpler than SQLAlchemy-based schedulers
"""

from celery import Celery

from app.core.config import settings

# Use configured broker/backend or fallback to REDIS_URL
# Settings validator already converts empty strings to None
broker_url = settings.CELERY_BROKER_URL or settings.REDIS_URL
result_backend = settings.CELERY_RESULT_BACKEND or settings.REDIS_URL

celery_app = Celery(
    "wegent",
    broker=broker_url,
    backend=result_backend,
    include=["app.tasks.flow_tasks"],
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
        "check-due-flows": {
            "task": "app.tasks.flow_tasks.check_due_flows",
            "schedule": float(settings.FLOW_SCHEDULER_INTERVAL_SECONDS),
        },
    },
    # Beat scheduler class - Use RedBeat for Redis-based distributed scheduling
    beat_scheduler="redbeat.schedulers:RedBeatScheduler",
    # RedBeat configuration (Redis-based scheduler)
    redbeat_redis_url=broker_url,  # Use same Redis as broker
    redbeat_key_prefix="celery:beat:",  # Redis key prefix for beat schedule
    # Increased lock timeout to prevent "LockNotOwnedError" during GC pauses or slow operations
    # The lock must be held long enough for the scheduler to complete its tick cycle
    redbeat_lock_timeout=300,  # Lock timeout in seconds (5 minutes)
    # Control the maximum sleep interval between beat ticks
    # This ensures the lock is extended frequently enough before expiration
    beat_max_loop_interval=60,  # Maximum seconds between scheduler ticks (1 minute)
)

# Import dead letter queue handlers to register signal handlers
# This must be done after celery_app is created
import app.core.dead_letter_queue  # noqa: E402, F401
