"""
APScheduler scheduler backend implementation.

This module provides a lightweight APScheduler-based scheduler backend that:
- Does not require Redis or external message brokers
- Supports memory or SQLite job stores
- Suitable for single-instance deployments or development environments
"""

import logging
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from app.core.scheduler.base import ScheduledJob, SchedulerBackend, SchedulerState

logger = logging.getLogger(__name__)


class APSchedulerBackend(SchedulerBackend):
    """
    APScheduler scheduler backend implementation.

    This backend uses APScheduler's BackgroundScheduler for scheduling:
    - Runs as a background thread within the application
    - Supports memory or SQLite job stores
    - No external dependencies (Redis, etc.)

    Ideal for:
    - Development environments
    - Single-instance deployments
    - Scenarios where Redis is not available
    """

    # Core job ID for the check_due_subscriptions periodic task
    CHECK_DUE_SUBSCRIPTIONS_JOB_ID = "check-due-subscriptions"

    def __init__(self, job_store: str = "memory"):
        """
        Initialize the APScheduler backend.

        Args:
            job_store: Job store type ("memory" or "sqlite")
        """
        self._job_store_type = job_store
        self._scheduler = None
        self._state = SchedulerState.STOPPED

    def _create_scheduler(self):
        """Create and configure the APScheduler instance."""
        try:
            from apscheduler.jobstores.memory import MemoryJobStore
            from apscheduler.schedulers.background import BackgroundScheduler
        except ImportError:
            raise ImportError(
                "APScheduler is not installed. "
                "Install it with: pip install apscheduler>=3.10.0"
            )

        jobstores = {}

        if self._job_store_type == "sqlite":
            try:
                from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore

                from app.core.config import settings

                sqlite_path = getattr(
                    settings, "APSCHEDULER_SQLITE_PATH", "scheduler_jobs.db"
                )
                jobstores["default"] = SQLAlchemyJobStore(
                    url=f"sqlite:///{sqlite_path}"
                )
                logger.info(
                    f"[APSchedulerBackend] Using SQLite job store: {sqlite_path}"
                )
            except ImportError:
                logger.warning(
                    "[APSchedulerBackend] SQLAlchemy not available for SQLite store, "
                    "falling back to memory store"
                )
                jobstores["default"] = MemoryJobStore()
        else:
            jobstores["default"] = MemoryJobStore()
            logger.info("[APSchedulerBackend] Using memory job store")

        self._scheduler = BackgroundScheduler(
            jobstores=jobstores,
            timezone="UTC",
            job_defaults={
                "coalesce": True,  # Combine multiple pending executions
                "max_instances": 1,  # Only one instance of each job at a time
                "misfire_grace_time": 60,  # Allow 60 seconds misfire grace time
            },
        )

    @property
    def backend_type(self) -> str:
        """Return the backend type identifier."""
        return "apscheduler"

    @property
    def state(self) -> SchedulerState:
        """Return the current scheduler state."""
        return self._state

    def start(self) -> None:
        """Start the APScheduler background scheduler."""
        if self._state == SchedulerState.RUNNING:
            logger.warning("[APSchedulerBackend] Already running, skipping start")
            return

        if self._scheduler is None:
            self._create_scheduler()

        if not self._scheduler.running:
            self._scheduler.start()
            logger.info("[APSchedulerBackend] Scheduler started")

        # Add the core check_due_subscriptions job
        self._add_check_due_subscriptions_job()

        self._state = SchedulerState.RUNNING

    def _add_check_due_subscriptions_job(self) -> None:
        """Add the check_due_subscriptions periodic job."""
        from app.core.config import settings

        # Check if job already exists
        existing_job = self._scheduler.get_job(self.CHECK_DUE_SUBSCRIPTIONS_JOB_ID)
        if existing_job:
            logger.info(
                f"[APSchedulerBackend] Job {self.CHECK_DUE_SUBSCRIPTIONS_JOB_ID} already exists"
            )
            return

        def check_due_subscriptions_wrapper():
            """Wrapper to execute check_due_subscriptions synchronously."""
            try:
                from app.tasks.subscription_tasks import check_due_subscriptions_sync

                check_due_subscriptions_sync()
            except ImportError:
                # Fallback to async version if sync not available
                logger.warning(
                    "[APSchedulerBackend] check_due_subscriptions_sync not available, "
                    "using Celery task directly"
                )
                from app.tasks.subscription_tasks import check_due_subscriptions

                # Call the underlying function, not the Celery task
                check_due_subscriptions()

        try:
            from apscheduler.triggers.interval import IntervalTrigger

            self._scheduler.add_job(
                check_due_subscriptions_wrapper,
                trigger=IntervalTrigger(
                    seconds=settings.FLOW_SCHEDULER_INTERVAL_SECONDS
                ),
                id=self.CHECK_DUE_SUBSCRIPTIONS_JOB_ID,
                name="Check Due Subscriptions",
                replace_existing=True,
            )
            logger.info(
                f"[APSchedulerBackend] Added job {self.CHECK_DUE_SUBSCRIPTIONS_JOB_ID} "
                f"with interval {settings.FLOW_SCHEDULER_INTERVAL_SECONDS}s"
            )
        except Exception as e:
            logger.error(
                f"[APSchedulerBackend] Failed to add check_due_subscriptions job: {e}"
            )

    def stop(self, wait: bool = True) -> None:
        """
        Stop the APScheduler background scheduler.

        Args:
            wait: Whether to wait for running jobs to complete
        """
        if self._state == SchedulerState.STOPPED:
            logger.warning("[APSchedulerBackend] Already stopped, skipping stop")
            return

        if self._scheduler and self._scheduler.running:
            self._scheduler.shutdown(wait=wait)
            logger.info("[APSchedulerBackend] Scheduler stopped")

        self._state = SchedulerState.STOPPED

    def pause(self) -> None:
        """Pause the scheduler."""
        if self._scheduler:
            self._scheduler.pause()
            self._state = SchedulerState.PAUSED
            logger.info("[APSchedulerBackend] Scheduler paused")

    def resume(self) -> None:
        """Resume the scheduler."""
        if self._scheduler:
            self._scheduler.resume()
            self._state = SchedulerState.RUNNING
            logger.info("[APSchedulerBackend] Scheduler resumed")

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
        Schedule a new job with APScheduler.

        Args:
            job_id: Unique job identifier
            func: Function to execute
            trigger_type: Trigger type (cron/interval/one_time)
            trigger_config: Trigger configuration
            args: Positional arguments for the function
            kwargs: Keyword arguments for the function
            replace_existing: Whether to replace existing job with same ID

        Returns:
            ScheduledJob: The scheduled job object
        """
        if self._scheduler is None:
            raise RuntimeError("Scheduler not started")

        trigger = self._build_trigger(trigger_type, trigger_config)

        job = self._scheduler.add_job(
            func,
            trigger=trigger,
            id=job_id,
            args=args,
            kwargs=kwargs or {},
            replace_existing=replace_existing,
        )

        logger.info(f"[APSchedulerBackend] Scheduled job: {job_id}")

        return ScheduledJob(
            job_id=job_id,
            name=job.name or job_id,
            trigger_type=trigger_type,
            trigger_config=trigger_config,
            next_run_time=job.next_run_time,
            func=func,
            args=args,
            kwargs=kwargs or {},
        )

    def _build_trigger(self, trigger_type: str, config: Dict[str, Any]):
        """
        Build APScheduler trigger from configuration.

        Args:
            trigger_type: Type of trigger (cron/interval/one_time)
            config: Trigger configuration

        Returns:
            APScheduler trigger object
        """
        from apscheduler.triggers.cron import CronTrigger
        from apscheduler.triggers.date import DateTrigger
        from apscheduler.triggers.interval import IntervalTrigger

        if trigger_type == "cron":
            expr = config.get("expression", "* * * * *")
            timezone = config.get("timezone", "UTC")
            return CronTrigger.from_crontab(expr, timezone=timezone)

        elif trigger_type == "interval":
            value = config.get("value", 60)
            unit = config.get("unit", "seconds")

            if unit == "minutes":
                return IntervalTrigger(minutes=value)
            elif unit == "hours":
                return IntervalTrigger(hours=value)
            elif unit == "days":
                return IntervalTrigger(days=value)
            return IntervalTrigger(seconds=value)

        elif trigger_type == "one_time":
            run_date = config.get("execute_at")
            if isinstance(run_date, str):
                run_date = datetime.fromisoformat(run_date.replace("Z", "+00:00"))
            return DateTrigger(run_date=run_date)

        # Default: interval in seconds
        seconds = config.get("seconds", 60)
        return IntervalTrigger(seconds=seconds)

    def remove_job(self, job_id: str) -> bool:
        """
        Remove a scheduled job.

        Args:
            job_id: Job identifier

        Returns:
            bool: Whether the job was successfully removed
        """
        if self._scheduler is None:
            return False

        try:
            self._scheduler.remove_job(job_id)
            logger.info(f"[APSchedulerBackend] Removed job: {job_id}")
            return True
        except Exception as e:
            logger.warning(f"[APSchedulerBackend] Failed to remove job {job_id}: {e}")
            return False

    def pause_job(self, job_id: str) -> bool:
        """
        Pause a single job.

        Args:
            job_id: Job identifier

        Returns:
            bool: Whether the job was successfully paused
        """
        if self._scheduler is None:
            return False

        try:
            self._scheduler.pause_job(job_id)
            logger.info(f"[APSchedulerBackend] Paused job: {job_id}")
            return True
        except Exception as e:
            logger.warning(f"[APSchedulerBackend] Failed to pause job {job_id}: {e}")
            return False

    def resume_job(self, job_id: str) -> bool:
        """
        Resume a paused job.

        Args:
            job_id: Job identifier

        Returns:
            bool: Whether the job was successfully resumed
        """
        if self._scheduler is None:
            return False

        try:
            self._scheduler.resume_job(job_id)
            logger.info(f"[APSchedulerBackend] Resumed job: {job_id}")
            return True
        except Exception as e:
            logger.warning(f"[APSchedulerBackend] Failed to resume job {job_id}: {e}")
            return False

    def get_job(self, job_id: str) -> Optional[ScheduledJob]:
        """
        Get information about a scheduled job.

        Args:
            job_id: Job identifier

        Returns:
            ScheduledJob or None
        """
        if self._scheduler is None:
            return None

        job = self._scheduler.get_job(job_id)
        if job is None:
            return None

        return ScheduledJob(
            job_id=job.id,
            name=job.name or job.id,
            trigger_type=self._infer_trigger_type(job.trigger),
            trigger_config={},
            next_run_time=job.next_run_time,
        )

    def get_jobs(self) -> List[ScheduledJob]:
        """
        Get all scheduled jobs.

        Returns:
            List of ScheduledJob objects
        """
        if self._scheduler is None:
            return []

        jobs = []
        for job in self._scheduler.get_jobs():
            jobs.append(
                ScheduledJob(
                    job_id=job.id,
                    name=job.name or job.id,
                    trigger_type=self._infer_trigger_type(job.trigger),
                    trigger_config={},
                    next_run_time=job.next_run_time,
                )
            )
        return jobs

    def _infer_trigger_type(self, trigger) -> str:
        """Infer trigger type from APScheduler trigger object."""
        type_name = type(trigger).__name__.lower()
        if "cron" in type_name:
            return "cron"
        elif "interval" in type_name:
            return "interval"
        elif "date" in type_name:
            return "one_time"
        return "unknown"

    def get_next_run_time(self, job_id: str) -> Optional[datetime]:
        """
        Get the next run time for a job.

        Args:
            job_id: Job identifier

        Returns:
            datetime or None
        """
        if self._scheduler is None:
            return None

        job = self._scheduler.get_job(job_id)
        return job.next_run_time if job else None

    def execute_job_now(self, job_id: str) -> Optional[str]:
        """
        Execute a job immediately.

        Args:
            job_id: Job identifier

        Returns:
            Job ID as execution ID, or None if job not found
        """
        if self._scheduler is None:
            return None

        job = self._scheduler.get_job(job_id)
        if job:
            # Execute the job function directly
            try:
                job.func(*job.args, **job.kwargs)
                logger.info(f"[APSchedulerBackend] Executed job immediately: {job_id}")
                return job_id
            except Exception as e:
                logger.error(
                    f"[APSchedulerBackend] Failed to execute job {job_id}: {e}"
                )
                return None

        return None

    def health_check(self) -> Dict[str, Any]:
        """
        Perform health check on the APScheduler backend.

        Returns:
            Dict containing health status information
        """
        healthy = False
        details: Dict[str, Any] = {
            "job_store": self._job_store_type,
        }

        if self._scheduler:
            healthy = self._scheduler.running
            details["scheduler_running"] = self._scheduler.running
            details["jobs_count"] = len(self._scheduler.get_jobs())

            # Get next job execution time
            jobs = self._scheduler.get_jobs()
            if jobs:
                next_times = [j.next_run_time for j in jobs if j.next_run_time]
                if next_times:
                    details["next_job_time"] = min(next_times).isoformat()
        else:
            details["scheduler_running"] = False

        return {
            "healthy": healthy,
            "backend_type": self.backend_type,
            "state": self._state.value,
            "jobs_count": details.get("jobs_count", 0),
            "details": details,
        }
