"""
Celery Beat scheduler backend implementation.

This module provides a Celery Beat-based scheduler backend that:
- Uses the existing celery_app.py configuration
- Supports embedded mode (Worker/Beat as threads) or standalone mode
- Maintains backward compatibility with existing Subscription scheduling
"""

import logging
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional

from app.core.scheduler.base import ScheduledJob, SchedulerBackend, SchedulerState

logger = logging.getLogger(__name__)


class CeleryBeatBackend(SchedulerBackend):
    """
    Celery Beat scheduler backend implementation.

    This backend leverages the existing Celery infrastructure for scheduling:
    - Uses beat_schedule for periodic task configuration
    - Supports embedded mode (threads) or standalone Celery processes
    - The core scheduling logic remains in check_due_subscriptions task

    Design notes:
    - Celery Beat is designed for static periodic tasks via configuration
    - Dynamic per-Subscription scheduling is handled by check_due_subscriptions querying the database
    - This backend manages the Beat lifecycle and provides a unified interface
    """

    # Core job ID for the check_due_subscriptions periodic task
    CHECK_DUE_SUBSCRIPTIONS_JOB_ID = "check-due-subscriptions"

    def __init__(self):
        """Initialize the Celery Beat backend."""
        self._state = SchedulerState.STOPPED
        self._celery_app = None
        self._jobs: Dict[str, ScheduledJob] = {}

    def _get_celery_app(self):
        """Lazy load celery app to avoid circular imports."""
        if self._celery_app is None:
            from app.core.celery_app import celery_app

            self._celery_app = celery_app
        return self._celery_app

    @property
    def backend_type(self) -> str:
        """Return the backend type identifier."""
        return "celery"

    @property
    def state(self) -> SchedulerState:
        """Return the current scheduler state."""
        return self._state

    def start(self) -> None:
        """
        Start the Celery Beat scheduler.

        In embedded mode, starts Worker and Beat as daemon threads.
        In standalone mode, relies on externally running Celery processes.
        """
        from app.core.config import settings

        if self._state == SchedulerState.RUNNING:
            logger.warning("[CeleryBeatBackend] Already running, skipping start")
            return

        if settings.EMBEDDED_CELERY_ENABLED:
            from app.core.embedded_celery import start_embedded_celery

            logger.info(
                "[CeleryBeatBackend] Starting embedded Celery Worker and Beat..."
            )
            start_embedded_celery()
            logger.info("[CeleryBeatBackend] Embedded Celery started")
        else:
            logger.info(
                "[CeleryBeatBackend] Standalone mode - "
                "ensure Celery Worker and Beat are running externally"
            )

        # Initialize the core check-due-subscriptions job in our tracking
        celery_app = self._get_celery_app()
        schedule = celery_app.conf.beat_schedule.get(
            self.CHECK_DUE_SUBSCRIPTIONS_JOB_ID
        )
        if schedule:
            self._jobs[self.CHECK_DUE_SUBSCRIPTIONS_JOB_ID] = ScheduledJob(
                job_id=self.CHECK_DUE_SUBSCRIPTIONS_JOB_ID,
                name=schedule.get("task", ""),
                trigger_type="interval",
                trigger_config={
                    "seconds": float(settings.FLOW_SCHEDULER_INTERVAL_SECONDS)
                },
                next_run_time=datetime.utcnow()
                + timedelta(seconds=settings.FLOW_SCHEDULER_INTERVAL_SECONDS),
            )

        self._state = SchedulerState.RUNNING

    def stop(self, wait: bool = True) -> None:
        """
        Stop the Celery Beat scheduler.

        Args:
            wait: Whether to wait for running tasks to complete (not used in embedded mode)
        """
        from app.core.config import settings

        if self._state == SchedulerState.STOPPED:
            logger.warning("[CeleryBeatBackend] Already stopped, skipping stop")
            return

        if settings.EMBEDDED_CELERY_ENABLED:
            from app.core.embedded_celery import stop_embedded_celery

            logger.info("[CeleryBeatBackend] Stopping embedded Celery...")
            stop_embedded_celery()
            logger.info("[CeleryBeatBackend] Embedded Celery stopped")
        else:
            logger.info(
                "[CeleryBeatBackend] Standalone mode - Celery processes remain running"
            )

        self._state = SchedulerState.STOPPED

    def schedule_job(
        self,
        job_id: str,
        func: Callable,
        trigger_type: str,
        trigger_config: Dict[str, Any],
        args: tuple = (),
        kwargs: Optional[Dict[str, Any]] = None,
        replace_existing: bool = True,
    ) -> ScheduledJob:
        """
        Schedule a new job in Celery Beat.

        Note: Celery Beat is designed for static configuration. Dynamic job
        scheduling is limited. For per-Subscription scheduling, use the database-driven
        approach via check_due_subscriptions.

        Args:
            job_id: Unique job identifier
            func: Function/task to execute (must be a registered Celery task)
            trigger_type: Trigger type (cron/interval)
            trigger_config: Trigger configuration
            args: Positional arguments for the task
            kwargs: Keyword arguments for the task
            replace_existing: Whether to replace existing job with same ID

        Returns:
            ScheduledJob: The scheduled job object
        """
        if not replace_existing and job_id in self._jobs:
            raise ValueError(f"Job '{job_id}' already exists")

        celery_app = self._get_celery_app()

        # Build Celery schedule
        schedule = self._build_celery_schedule(trigger_type, trigger_config)

        # Get task path
        if hasattr(func, "name"):
            # It's a Celery task
            task_path = func.name
        else:
            task_path = f"{func.__module__}.{func.__name__}"

        # Update beat_schedule
        celery_app.conf.beat_schedule[job_id] = {
            "task": task_path,
            "schedule": schedule,
            "args": args,
            "kwargs": kwargs or {},
        }

        # Calculate next run time
        next_run_time = self._calculate_next_run_time(trigger_type, trigger_config)

        job = ScheduledJob(
            job_id=job_id,
            name=task_path,
            trigger_type=trigger_type,
            trigger_config=trigger_config,
            next_run_time=next_run_time,
            func=func,
            args=args,
            kwargs=kwargs or {},
        )

        self._jobs[job_id] = job
        logger.info(f"[CeleryBeatBackend] Scheduled job: {job_id}")

        return job

    def _build_celery_schedule(self, trigger_type: str, config: Dict[str, Any]) -> Any:
        """
        Build Celery schedule object from trigger configuration.

        Args:
            trigger_type: Type of trigger (cron/interval)
            config: Trigger configuration

        Returns:
            Celery schedule object (crontab or float for seconds)
        """
        from celery.schedules import crontab

        if trigger_type == "cron":
            expr = config.get("expression", "* * * * *")
            parts = expr.split()
            if len(parts) >= 5:
                return crontab(
                    minute=parts[0],
                    hour=parts[1],
                    day_of_month=parts[2],
                    month_of_year=parts[3],
                    day_of_week=parts[4],
                )
            return crontab()

        elif trigger_type == "interval":
            value = config.get("value", 60)
            unit = config.get("unit", "seconds")

            if unit == "minutes":
                return float(value * 60)
            elif unit == "hours":
                return float(value * 3600)
            elif unit == "days":
                return float(value * 86400)
            return float(value)

        # Default: treat config.seconds as interval
        return float(config.get("seconds", 60))

    def _calculate_next_run_time(
        self, trigger_type: str, config: Dict[str, Any]
    ) -> Optional[datetime]:
        """Calculate the next run time based on trigger configuration."""
        now = datetime.utcnow()

        if trigger_type == "cron":
            try:
                from croniter import croniter

                expr = config.get("expression", "* * * * *")
                cron = croniter(expr, now)
                return cron.get_next(datetime)
            except ImportError:
                logger.warning(
                    "croniter not available, cannot calculate cron next run time"
                )
                return None

        elif trigger_type == "interval":
            value = config.get("value", 60)
            unit = config.get("unit", "seconds")

            if unit == "minutes":
                return now + timedelta(minutes=value)
            elif unit == "hours":
                return now + timedelta(hours=value)
            elif unit == "days":
                return now + timedelta(days=value)
            return now + timedelta(seconds=value)

        # Default interval
        seconds = config.get("seconds", 60)
        return now + timedelta(seconds=seconds)

    def remove_job(self, job_id: str) -> bool:
        """
        Remove a scheduled job.

        Args:
            job_id: Job identifier

        Returns:
            bool: Whether the job was successfully removed
        """
        celery_app = self._get_celery_app()

        if job_id in celery_app.conf.beat_schedule:
            del celery_app.conf.beat_schedule[job_id]

        if job_id in self._jobs:
            del self._jobs[job_id]
            logger.info(f"[CeleryBeatBackend] Removed job: {job_id}")
            return True

        return False

    def get_job(self, job_id: str) -> Optional[ScheduledJob]:
        """
        Get information about a scheduled job.

        Args:
            job_id: Job identifier

        Returns:
            ScheduledJob or None
        """
        return self._jobs.get(job_id)

    def get_jobs(self) -> List[ScheduledJob]:
        """
        Get all scheduled jobs.

        Returns:
            List of ScheduledJob objects
        """
        return list(self._jobs.values())

    def get_next_run_time(self, job_id: str) -> Optional[datetime]:
        """
        Get the next run time for a job.

        Args:
            job_id: Job identifier

        Returns:
            datetime or None
        """
        job = self._jobs.get(job_id)
        if job:
            return job.next_run_time
        return None

    def execute_job_now(self, job_id: str) -> Optional[str]:
        """
        Execute a job immediately using Celery apply_async.

        Args:
            job_id: Job identifier

        Returns:
            Celery task ID, or None if job not found
        """
        if job_id == self.CHECK_DUE_SUBSCRIPTIONS_JOB_ID:
            from app.tasks.subscription_tasks import check_due_subscriptions

            result = check_due_subscriptions.apply_async()
            logger.info(
                f"[CeleryBeatBackend] Triggered {job_id} immediately, task_id: {result.id}"
            )
            return result.id

        job = self._jobs.get(job_id)
        if job and job.func:
            if hasattr(job.func, "apply_async"):
                result = job.func.apply_async(args=job.args, kwargs=job.kwargs)
                return result.id
            else:
                # Direct function call for non-Celery functions
                job.func(*job.args, **job.kwargs)
                return job_id

        return None

    def health_check(self) -> Dict[str, Any]:
        """
        Perform health check on the Celery Beat backend.

        Returns:
            Dict containing health status information
        """
        from app.core.config import settings

        healthy = True
        details: Dict[str, Any] = {
            "embedded_mode": settings.EMBEDDED_CELERY_ENABLED,
        }

        if settings.EMBEDDED_CELERY_ENABLED:
            from app.core.embedded_celery import is_celery_running

            running = is_celery_running()
            healthy = running
            details["celery_running"] = running
        else:
            # Check Redis connectivity for standalone mode
            try:
                from redis import Redis

                redis_client = Redis.from_url(settings.REDIS_URL)
                redis_client.ping()
                details["redis_connected"] = True
            except Exception as e:
                healthy = False
                details["redis_error"] = str(e)
                details["redis_connected"] = False

        return {
            "healthy": healthy,
            "backend_type": self.backend_type,
            "state": self._state.value,
            "jobs_count": len(self._jobs),
            "details": details,
        }
