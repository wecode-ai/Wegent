"""
Scheduler Backend Abstraction Layer.

This module defines the abstract base class for scheduler backends,
supporting multiple scheduling engines:
- Celery Beat (default)
- APScheduler (lightweight)
- XXL-JOB (enterprise distributed)
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, List, Optional


class SchedulerState(str, Enum):
    """Scheduler state enumeration."""

    STOPPED = "stopped"
    RUNNING = "running"
    PAUSED = "paused"


@dataclass
class ScheduledJob:
    """Unified representation of a scheduled job."""

    job_id: str
    name: str
    trigger_type: str  # cron / interval / one_time
    trigger_config: Dict[str, Any]
    next_run_time: Optional[datetime] = None
    func: Optional[Callable] = None
    args: tuple = ()
    kwargs: Dict[str, Any] = field(default_factory=dict)


@dataclass
class JobExecutionResult:
    """Result of a job execution."""

    job_id: str
    success: bool
    started_at: datetime
    completed_at: Optional[datetime] = None
    result: Any = None
    error_message: Optional[str] = None


class SchedulerBackend(ABC):
    """
    Abstract base class for scheduler backends.

    Defines the unified interface that all scheduler backends must implement:
    - Lifecycle management (start/stop/pause/resume)
    - Job scheduling (schedule_job/remove_job/pause_job/resume_job)
    - Job querying (get_job/get_jobs/get_next_run_time)
    - Health checking (health_check)

    Implementation considerations:
    1. Celery Beat: Uses beat_schedule configuration for periodic tasks
    2. APScheduler: Directly adds/removes jobs via scheduler API
    3. XXL-JOB: Interacts with XXL-JOB Admin via HTTP API
    """

    @property
    @abstractmethod
    def backend_type(self) -> str:
        """Return the backend type identifier (e.g., 'celery', 'apscheduler', 'xxljob')."""
        pass

    @property
    @abstractmethod
    def state(self) -> SchedulerState:
        """Return the current scheduler state."""
        pass

    # ============ Lifecycle Management ============

    @abstractmethod
    def start(self) -> None:
        """
        Start the scheduler.

        For Celery Beat: Start the Beat thread
        For APScheduler: Call scheduler.start()
        For XXL-JOB: Register executor and start heartbeat
        """
        pass

    @abstractmethod
    def stop(self, wait: bool = True) -> None:
        """
        Stop the scheduler.

        Args:
            wait: Whether to wait for running jobs to complete
        """
        pass

    def pause(self) -> None:
        """Pause the scheduler (optional implementation)."""
        raise NotImplementedError(f"{self.backend_type} does not support pause")

    def resume(self) -> None:
        """Resume the scheduler (optional implementation)."""
        raise NotImplementedError(f"{self.backend_type} does not support resume")

    # ============ Job Scheduling Management ============

    @abstractmethod
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
        Schedule a new job.

        Args:
            job_id: Unique job identifier
            func: Function/task to execute
            trigger_type: Trigger type (cron/interval/one_time)
            trigger_config: Trigger configuration
            args: Positional arguments
            kwargs: Keyword arguments
            replace_existing: Whether to replace existing job with same ID

        Returns:
            ScheduledJob: The scheduled job object
        """
        pass

    @abstractmethod
    def remove_job(self, job_id: str) -> bool:
        """
        Remove a scheduled job.

        Args:
            job_id: Job identifier

        Returns:
            bool: Whether the job was successfully removed
        """
        pass

    def pause_job(self, job_id: str) -> bool:
        """Pause a single job (optional implementation)."""
        raise NotImplementedError(f"{self.backend_type} does not support pause_job")

    def resume_job(self, job_id: str) -> bool:
        """Resume a single job (optional implementation)."""
        raise NotImplementedError(f"{self.backend_type} does not support resume_job")

    # ============ Job Querying ============

    @abstractmethod
    def get_job(self, job_id: str) -> Optional[ScheduledJob]:
        """
        Get information about a single scheduled job.

        Args:
            job_id: Job identifier

        Returns:
            ScheduledJob or None
        """
        pass

    @abstractmethod
    def get_jobs(self) -> List[ScheduledJob]:
        """
        Get all scheduled jobs.

        Returns:
            List[ScheduledJob]: List of scheduled jobs
        """
        pass

    @abstractmethod
    def get_next_run_time(self, job_id: str) -> Optional[datetime]:
        """
        Get the next run time for a job.

        Args:
            job_id: Job identifier

        Returns:
            datetime or None
        """
        pass

    # ============ Job Execution (for manual trigger) ============

    def execute_job_now(self, job_id: str) -> Optional[str]:
        """
        Execute a job immediately (for manual trigger).

        Args:
            job_id: Job identifier

        Returns:
            Execution task ID (e.g., Celery task_id), or None
        """
        raise NotImplementedError(
            f"{self.backend_type} does not support execute_job_now"
        )

    # ============ Health Check ============

    @abstractmethod
    def health_check(self) -> Dict[str, Any]:
        """
        Perform health check.

        Returns:
            Dict containing health status:
            {
                "healthy": bool,
                "backend_type": str,
                "state": str,
                "jobs_count": int,
                "details": {...}
            }
        """
        pass
