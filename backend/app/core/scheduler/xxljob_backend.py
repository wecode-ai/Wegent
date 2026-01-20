"""
XXL-JOB scheduler backend implementation.

This module provides an XXL-JOB-based scheduler backend that:
- Integrates with XXL-JOB Admin via HTTP API
- Supports distributed task scheduling
- Provides enterprise-grade features like sharding, failover, and task dependencies

For more information about XXL-JOB, see: https://github.com/xuxueli/xxl-job
"""

import json
import logging
import socket
import threading
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from app.core.scheduler.base import ScheduledJob, SchedulerBackend, SchedulerState

logger = logging.getLogger(__name__)


class XXLJobBackend(SchedulerBackend):
    """
    XXL-JOB scheduler backend implementation.

    This backend integrates with XXL-JOB Admin for enterprise-grade scheduling:
    - Distributed task execution with executor auto-registration
    - Visual operation dashboard (via XXL-JOB Admin)
    - Sharding broadcast for parallel processing
    - Failover and retry mechanisms

    Requirements:
    - XXL-JOB Admin must be deployed and accessible
    - Executor needs to be registered with Admin

    Architecture:
        XXL-JOB Admin (Scheduling Center)
              │
              │ HTTP callbacks
              ▼
        Wegent Executor (this backend)
              │
              ▼
        Flow execution logic
    """

    # Core job ID for the check_due_subscriptions periodic task
    CHECK_DUE_SUBSCRIPTIONS_JOB_ID = "check-due-subscriptions"

    # XXL-JOB API endpoints
    API_REGISTRY = "/api/registry"
    API_REGISTRY_REMOVE = "/api/registryRemove"
    API_JOB_ADD = "/jobinfo/add"
    API_JOB_UPDATE = "/jobinfo/update"
    API_JOB_REMOVE = "/jobinfo/remove"
    API_JOB_START = "/jobinfo/start"
    API_JOB_STOP = "/jobinfo/stop"
    API_JOB_TRIGGER = "/jobinfo/trigger"
    API_JOB_PAGE_LIST = "/jobinfo/pageList"

    def __init__(
        self,
        admin_addresses: List[str],
        app_name: str = "wegent-executor",
        access_token: Optional[str] = None,
        executor_port: int = 9999,
        executor_log_path: str = "/tmp/xxl-job/logs",
    ):
        """
        Initialize the XXL-JOB backend.

        Args:
            admin_addresses: List of XXL-JOB Admin addresses
            app_name: Executor application name (must match XXL-JOB Admin config)
            access_token: Access token for authentication
            executor_port: Port for executor callbacks
            executor_log_path: Path for executor logs
        """
        self._admin_addresses = admin_addresses
        self._app_name = app_name
        self._access_token = access_token
        self._executor_port = executor_port
        self._executor_log_path = executor_log_path

        self._state = SchedulerState.STOPPED
        self._registered_jobs: Dict[str, ScheduledJob] = {}
        self._xxl_job_ids: Dict[str, int] = {}  # job_id -> XXL-JOB internal ID
        self._job_group_id: Optional[int] = None  # Executor group ID in XXL-JOB

        self._heartbeat_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    @property
    def backend_type(self) -> str:
        """Return the backend type identifier."""
        return "xxljob"

    @property
    def state(self) -> SchedulerState:
        """Return the current scheduler state."""
        return self._state

    def _get_executor_ip(self) -> str:
        """Get the executor's IP address."""
        try:
            hostname = socket.gethostname()
            return socket.gethostbyname(hostname)
        except Exception:
            return "127.0.0.1"

    def _api_request(
        self,
        endpoint: str,
        method: str = "POST",
        data: Optional[Dict] = None,
        admin_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Send HTTP request to XXL-JOB Admin.

        Args:
            endpoint: API endpoint path
            method: HTTP method
            data: Request data
            admin_url: Specific admin URL (if None, tries all)

        Returns:
            Response JSON as dict

        Raises:
            RuntimeError: If all admin addresses fail
        """
        import requests

        headers = {"Content-Type": "application/json"}
        if self._access_token:
            headers["XXL-JOB-ACCESS-TOKEN"] = self._access_token

        urls_to_try = [admin_url] if admin_url else self._admin_addresses

        last_error = None
        for url in urls_to_try:
            try:
                full_url = f"{url.rstrip('/')}{endpoint}"

                if method == "GET":
                    response = requests.get(
                        full_url, headers=headers, params=data, timeout=10
                    )
                else:
                    response = requests.post(
                        full_url, headers=headers, json=data, timeout=10
                    )

                result = response.json()

                # XXL-JOB returns code 200 for success
                if result.get("code") == 200:
                    return result
                else:
                    logger.warning(
                        f"[XXLJobBackend] API call failed: {endpoint}, "
                        f"response: {result}"
                    )
                    last_error = result.get("msg", "Unknown error")

            except Exception as e:
                logger.warning(f"[XXLJobBackend] Request to {url} failed: {e}")
                last_error = str(e)

        raise RuntimeError(f"All XXL-JOB Admin addresses failed: {last_error}")

    def _register_executor(self) -> None:
        """Register this executor with XXL-JOB Admin."""
        executor_ip = self._get_executor_ip()
        executor_address = f"{executor_ip}:{self._executor_port}"

        data = {
            "registryGroup": "EXECUTOR",
            "registryKey": self._app_name,
            "registryValue": executor_address,
        }

        try:
            self._api_request(self.API_REGISTRY, data=data)
            logger.info(
                f"[XXLJobBackend] Registered executor: {self._app_name} -> {executor_address}"
            )
        except Exception as e:
            logger.error(f"[XXLJobBackend] Failed to register executor: {e}")
            raise

    def _unregister_executor(self) -> None:
        """Unregister this executor from XXL-JOB Admin."""
        executor_ip = self._get_executor_ip()
        executor_address = f"{executor_ip}:{self._executor_port}"

        data = {
            "registryGroup": "EXECUTOR",
            "registryKey": self._app_name,
            "registryValue": executor_address,
        }

        try:
            self._api_request(self.API_REGISTRY_REMOVE, data=data)
            logger.info(f"[XXLJobBackend] Unregistered executor: {self._app_name}")
        except Exception as e:
            logger.warning(f"[XXLJobBackend] Failed to unregister executor: {e}")

    def _start_heartbeat(self) -> None:
        """Start the heartbeat thread for executor registration."""

        def heartbeat_loop():
            while not self._stop_event.is_set():
                try:
                    self._register_executor()
                except Exception as e:
                    logger.warning(f"[XXLJobBackend] Heartbeat failed: {e}")

                # Wait 30 seconds before next heartbeat
                self._stop_event.wait(30)

        self._heartbeat_thread = threading.Thread(
            target=heartbeat_loop,
            daemon=True,
            name="xxljob-heartbeat",
        )
        self._heartbeat_thread.start()
        logger.info("[XXLJobBackend] Heartbeat thread started")

    def _stop_heartbeat(self) -> None:
        """Stop the heartbeat thread."""
        self._stop_event.set()
        if self._heartbeat_thread:
            self._heartbeat_thread.join(timeout=5)
            self._heartbeat_thread = None
        logger.info("[XXLJobBackend] Heartbeat thread stopped")

    def start(self) -> None:
        """
        Start the XXL-JOB backend.

        This will:
        1. Register the executor with XXL-JOB Admin
        2. Start the heartbeat thread
        3. Register the core check_due_flows job
        """
        if self._state == SchedulerState.RUNNING:
            logger.warning("[XXLJobBackend] Already running, skipping start")
            return

        if not self._admin_addresses:
            raise RuntimeError(
                "[XXLJobBackend] No XXL-JOB Admin addresses configured. "
                "Set XXLJOB_ADMIN_ADDRESSES in configuration."
            )

        # Register executor
        self._register_executor()

        # Start heartbeat
        self._stop_event.clear()
        self._start_heartbeat()

        # Add core check_due_subscriptions job
        self._add_check_due_subscriptions_job()

        self._state = SchedulerState.RUNNING
        logger.info("[XXLJobBackend] Started successfully")

    def _add_check_due_subscriptions_job(self) -> None:
        """Add the check_due_subscriptions periodic job to XXL-JOB."""
        from app.core.config import settings

        # Build cron expression for the interval
        # XXL-JOB uses 6-part cron (with seconds)
        interval = settings.FLOW_SCHEDULER_INTERVAL_SECONDS

        if interval < 60:
            # Run every N seconds
            cron_expr = f"*/{interval} * * * * ?"
        elif interval < 3600:
            # Run every N minutes
            minutes = interval // 60
            cron_expr = f"0 */{minutes} * * * ?"
        else:
            # Run every N hours
            hours = interval // 3600
            cron_expr = f"0 0 */{hours} * * ?"

        try:
            self.schedule_job(
                job_id=self.CHECK_DUE_SUBSCRIPTIONS_JOB_ID,
                func=self._check_due_subscriptions_handler,
                trigger_type="cron",
                trigger_config={"expression": cron_expr},
                replace_existing=True,
            )
        except Exception as e:
            logger.warning(
                f"[XXLJobBackend] Failed to add check_due_subscriptions job "
                f"(may need manual creation in Admin): {e}"
            )

    @staticmethod
    def _check_due_subscriptions_handler():
        """Handler function for check_due_subscriptions job."""
        try:
            from app.tasks.subscription_tasks import check_due_subscriptions_sync

            check_due_subscriptions_sync()
        except ImportError:
            from app.tasks.subscription_tasks import check_due_subscriptions

            check_due_subscriptions()

    def stop(self, wait: bool = True) -> None:
        """
        Stop the XXL-JOB backend.

        Args:
            wait: Whether to wait for running jobs to complete
        """
        if self._state == SchedulerState.STOPPED:
            logger.warning("[XXLJobBackend] Already stopped, skipping stop")
            return

        # Stop heartbeat
        self._stop_heartbeat()

        # Unregister executor
        self._unregister_executor()

        self._state = SchedulerState.STOPPED
        logger.info("[XXLJobBackend] Stopped successfully")

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
        Schedule a new job in XXL-JOB Admin.

        Note: XXL-JOB requires jobs to be created in the Admin console first,
        or via API with proper executor group configuration.

        Args:
            job_id: Unique job identifier
            func: Handler function
            trigger_type: Trigger type (cron/interval)
            trigger_config: Trigger configuration
            args: Positional arguments (stored in executor params)
            kwargs: Keyword arguments (stored in executor params)
            replace_existing: Whether to replace existing job

        Returns:
            ScheduledJob: The scheduled job object
        """
        # Build cron expression
        cron_expr = self._build_cron_expression(trigger_type, trigger_config)

        # Prepare executor parameters
        executor_param = json.dumps(
            {
                "job_id": job_id,
                "func": f"{func.__module__}.{func.__name__}" if func else None,
                "args": args,
                "kwargs": kwargs or {},
            }
        )

        # Create job in XXL-JOB Admin
        job_data = {
            "jobGroup": self._job_group_id or 1,  # Default to group 1
            "jobDesc": f"Wegent Subscription: {job_id}",
            "author": "wegent",
            "scheduleType": "CRON",
            "scheduleConf": cron_expr,
            "misfireStrategy": "DO_NOTHING",
            "executorRouteStrategy": "FIRST",
            "executorHandler": "flowSchedulerHandler",
            "executorParam": executor_param,
            "executorBlockStrategy": "SERIAL_EXECUTION",
            "executorTimeout": 0,
            "executorFailRetryCount": 3,
            "glueType": "BEAN",
            "triggerStatus": 1,  # Start immediately
        }

        try:
            if job_id in self._xxl_job_ids and replace_existing:
                # Update existing job
                job_data["id"] = self._xxl_job_ids[job_id]
                result = self._api_request(self.API_JOB_UPDATE, data=job_data)
                xxl_job_id = self._xxl_job_ids[job_id]
            else:
                # Create new job
                result = self._api_request(self.API_JOB_ADD, data=job_data)
                xxl_job_id = result.get("content")
                self._xxl_job_ids[job_id] = xxl_job_id

            logger.info(
                f"[XXLJobBackend] Scheduled job: {job_id} (xxl_job_id: {xxl_job_id})"
            )

        except Exception as e:
            logger.error(f"[XXLJobBackend] Failed to schedule job {job_id}: {e}")
            # Still track locally even if API fails
            xxl_job_id = None

        # Calculate next run time
        next_run_time = self._calculate_next_from_cron(cron_expr)

        job = ScheduledJob(
            job_id=job_id,
            name=f"XXL-JOB: {job_id}",
            trigger_type=trigger_type,
            trigger_config=trigger_config,
            next_run_time=next_run_time,
            func=func,
            args=args,
            kwargs=kwargs or {},
        )

        self._registered_jobs[job_id] = job
        return job

    def _build_cron_expression(self, trigger_type: str, config: Dict[str, Any]) -> str:
        """
        Build XXL-JOB cron expression (6-part with seconds).

        Args:
            trigger_type: Type of trigger
            config: Trigger configuration

        Returns:
            6-part cron expression string
        """
        if trigger_type == "cron":
            expr = config.get("expression", "* * * * *")
            parts = expr.split()

            # Convert 5-part cron to 6-part (add seconds)
            if len(parts) == 5:
                return f"0 {expr}"
            return expr

        elif trigger_type == "interval":
            value = config.get("value", 60)
            unit = config.get("unit", "seconds")

            if unit == "seconds":
                return f"*/{value} * * * * ?"
            elif unit == "minutes":
                return f"0 */{value} * * * ?"
            elif unit == "hours":
                return f"0 0 */{value} * * ?"
            elif unit == "days":
                return f"0 0 0 */{value} * ?"

        # Default: every minute
        return "0 * * * * ?"

    def _calculate_next_from_cron(self, cron_expr: str) -> Optional[datetime]:
        """Calculate next run time from cron expression."""
        try:
            from croniter import croniter

            # Remove seconds part for croniter (it uses 5-part cron)
            parts = cron_expr.split()
            if len(parts) == 6:
                five_part_cron = " ".join(parts[1:])
            else:
                five_part_cron = cron_expr

            # Handle ? (XXL-JOB wildcard) -> * (standard cron)
            five_part_cron = five_part_cron.replace("?", "*")

            cron = croniter(five_part_cron, datetime.utcnow())
            return cron.get_next(datetime)
        except Exception as e:
            logger.warning(f"[XXLJobBackend] Cannot calculate next run time: {e}")
            return None

    def remove_job(self, job_id: str) -> bool:
        """
        Remove a scheduled job from XXL-JOB Admin.

        Args:
            job_id: Job identifier

        Returns:
            bool: Whether the job was successfully removed
        """
        try:
            if job_id in self._xxl_job_ids:
                xxl_job_id = self._xxl_job_ids[job_id]
                self._api_request(self.API_JOB_REMOVE, data={"id": xxl_job_id})
                del self._xxl_job_ids[job_id]

            if job_id in self._registered_jobs:
                del self._registered_jobs[job_id]

            logger.info(f"[XXLJobBackend] Removed job: {job_id}")
            return True

        except Exception as e:
            logger.error(f"[XXLJobBackend] Failed to remove job {job_id}: {e}")
            return False

    def pause_job(self, job_id: str) -> bool:
        """
        Pause a job in XXL-JOB Admin.

        Args:
            job_id: Job identifier

        Returns:
            bool: Whether the job was successfully paused
        """
        try:
            if job_id in self._xxl_job_ids:
                xxl_job_id = self._xxl_job_ids[job_id]
                self._api_request(self.API_JOB_STOP, data={"id": xxl_job_id})
                logger.info(f"[XXLJobBackend] Paused job: {job_id}")
                return True
        except Exception as e:
            logger.error(f"[XXLJobBackend] Failed to pause job {job_id}: {e}")

        return False

    def resume_job(self, job_id: str) -> bool:
        """
        Resume a paused job in XXL-JOB Admin.

        Args:
            job_id: Job identifier

        Returns:
            bool: Whether the job was successfully resumed
        """
        try:
            if job_id in self._xxl_job_ids:
                xxl_job_id = self._xxl_job_ids[job_id]
                self._api_request(self.API_JOB_START, data={"id": xxl_job_id})
                logger.info(f"[XXLJobBackend] Resumed job: {job_id}")
                return True
        except Exception as e:
            logger.error(f"[XXLJobBackend] Failed to resume job {job_id}: {e}")

        return False

    def get_job(self, job_id: str) -> Optional[ScheduledJob]:
        """
        Get information about a scheduled job.

        Args:
            job_id: Job identifier

        Returns:
            ScheduledJob or None
        """
        return self._registered_jobs.get(job_id)

    def get_jobs(self) -> List[ScheduledJob]:
        """
        Get all scheduled jobs.

        Returns:
            List of ScheduledJob objects
        """
        return list(self._registered_jobs.values())

    def get_next_run_time(self, job_id: str) -> Optional[datetime]:
        """
        Get the next run time for a job.

        Args:
            job_id: Job identifier

        Returns:
            datetime or None
        """
        job = self._registered_jobs.get(job_id)
        return job.next_run_time if job else None

    def execute_job_now(self, job_id: str) -> Optional[str]:
        """
        Trigger a job to execute immediately via XXL-JOB Admin.

        Args:
            job_id: Job identifier

        Returns:
            Execution ID or None
        """
        try:
            if job_id in self._xxl_job_ids:
                xxl_job_id = self._xxl_job_ids[job_id]
                self._api_request(
                    self.API_JOB_TRIGGER,
                    data={"id": xxl_job_id, "executorParam": ""},
                )
                logger.info(f"[XXLJobBackend] Triggered job immediately: {job_id}")
                return str(xxl_job_id)

            # Fallback: execute locally
            job = self._registered_jobs.get(job_id)
            if job and job.func:
                job.func(*job.args, **job.kwargs)
                return job_id

        except Exception as e:
            logger.error(f"[XXLJobBackend] Failed to trigger job {job_id}: {e}")

        return None

    def health_check(self) -> Dict[str, Any]:
        """
        Perform health check on the XXL-JOB backend.

        Returns:
            Dict containing health status information
        """
        healthy = False
        details: Dict[str, Any] = {
            "admin_addresses": self._admin_addresses,
            "app_name": self._app_name,
        }

        # Try to ping each admin
        for admin_url in self._admin_addresses:
            try:
                # Try registry endpoint as health check
                self._api_request(
                    self.API_REGISTRY,
                    data={
                        "registryGroup": "EXECUTOR",
                        "registryKey": self._app_name,
                        "registryValue": f"{self._get_executor_ip()}:{self._executor_port}",
                    },
                    admin_url=admin_url,
                )
                healthy = True
                details["connected_admin"] = admin_url
                break
            except Exception as e:
                details[f"error_{admin_url}"] = str(e)

        return {
            "healthy": healthy,
            "backend_type": self.backend_type,
            "state": self._state.value,
            "jobs_count": len(self._registered_jobs),
            "details": details,
        }
