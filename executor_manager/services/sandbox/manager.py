# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SandboxManager service for E2B-like sandbox lifecycle management.

This service handles:
- Sandbox creation and termination
- Execution management within sandboxes
- Health monitoring and garbage collection
- Redis-based state persistence
"""

import asyncio
import os
import time
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from shared.logger import setup_logger

from executor_manager.common.config import get_config
from executor_manager.common.distributed_lock import get_distributed_lock
from executor_manager.common.singleton import SingletonMeta
from executor_manager.config.config import EXECUTOR_DISPATCHER_MODE
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.models.sandbox import (Execution, ExecutionStatus,
                                             Sandbox, SandboxStatus)
from executor_manager.services.heartbeat_manager import get_heartbeat_manager
from executor_manager.services.sandbox.execution_runner import \
    get_execution_runner
from executor_manager.services.sandbox.health_checker import \
    get_container_health_checker
from executor_manager.services.sandbox.repository import get_sandbox_repository
from executor_manager.utils.executor_name import generate_executor_name

if TYPE_CHECKING:
    from executor_manager.services.sandbox.scheduler import SandboxScheduler

logger = setup_logger(__name__)


class SandboxManager(metaclass=SingletonMeta):
    """Manager for sandbox lifecycle and execution management.

    This class implements the E2B-like protocol for managing isolated
    execution environments (sandboxes) running in Docker containers.

    Features:
    - Create/terminate sandboxes
    - Execute tasks within sandboxes
    - Health monitoring and automatic cleanup
    - Redis-based state persistence via SandboxRepository
    """

    def __init__(self):
        """Initialize the SandboxManager."""
        self._config = get_config()
        self._repository = get_sandbox_repository()
        self._health_checker = get_container_health_checker()
        self._execution_runner = get_execution_runner()
        self._scheduler: Optional["SandboxScheduler"] = None
        self._shutting_down = False

    # =========================================================================
    # Sandbox Lifecycle
    # =========================================================================

    async def create_sandbox(
        self,
        shell_type: str,
        user_id: int,
        user_name: str,
        timeout: Optional[int] = None,
        workspace_ref: Optional[str] = None,
        bot_config: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Sandbox, Optional[str]]:
        """Create a new sandbox.

        Args:
            shell_type: Execution environment type (ClaudeCode, Agno)
            user_id: User ID
            user_name: Username
            timeout: Sandbox timeout in seconds (defaults to config)
            workspace_ref: Optional workspace reference
            bot_config: Optional bot configuration
            metadata: Optional additional metadata

        Returns:
            Tuple of (Sandbox, error_message or None)
        """
        if timeout is None:
            timeout = self._config.timeout.sandbox_default

        logger.info(
            f"[SandboxManager] Creating sandbox: shell_type={shell_type}, "
            f"user={user_name}, timeout={timeout}s"
        )

        # Check if sandbox already exists for this task
        sandbox_metadata = metadata or {}
        task_id = sandbox_metadata.get("task_id")

        if task_id is not None:
            # Check by task_id only (not subtask_id) to reuse sandbox across subtasks
            existing_sandbox = self._repository.load_sandbox(str(task_id))
            if existing_sandbox and existing_sandbox.is_active():
                # Verify container is actually alive via health check
                if existing_sandbox.base_url:
                    is_healthy = self._health_checker.check_health_sync(
                        existing_sandbox.base_url
                    )
                    if is_healthy:
                        logger.info(
                            f"[SandboxManager] Reusing existing sandbox {existing_sandbox.sandbox_id} "
                            f"for task {task_id} (health check passed)"
                        )
                        # Extend timeout
                        existing_sandbox.extend_timeout(timeout)
                        self._repository.save_sandbox(existing_sandbox)
                        return existing_sandbox, None
                    else:
                        # Container is dead, clean up and create new one
                        logger.warning(
                            f"[SandboxManager] Existing sandbox {existing_sandbox.sandbox_id} "
                            f"failed health check, will create new sandbox"
                        )
                        await self._cleanup_dead_sandbox(existing_sandbox)

        # Create new sandbox
        if workspace_ref:
            sandbox_metadata["workspace_ref"] = workspace_ref
        if bot_config:
            sandbox_metadata["bot_config"] = bot_config

        sandbox = Sandbox.create(
            shell_type=shell_type,
            user_id=user_id,
            user_name=user_name,
            timeout=timeout,
            metadata=sandbox_metadata,
        )

        # Save initial state to Redis
        self._repository.save_sandbox(sandbox)

        # Start container in background
        try:
            error = await self._start_sandbox_container(sandbox)
            if error:
                sandbox.set_failed(error)
                self._repository.save_sandbox(sandbox)
                return sandbox, error
        except Exception as e:
            error_msg = f"Failed to start container: {str(e)}"
            logger.error(f"[SandboxManager] {error_msg}", exc_info=True)
            sandbox.set_failed(error_msg)
            self._repository.save_sandbox(sandbox)
            return sandbox, error_msg

        logger.info(
            f"[SandboxManager] Sandbox created: sandbox_id={sandbox.sandbox_id}, "
            f"container={sandbox.container_name}, base_url={sandbox.base_url}"
        )

        return sandbox, None

    async def _start_sandbox_container(self, sandbox: Sandbox) -> Optional[str]:
        """Start the container for a sandbox.

        Args:
            sandbox: Sandbox to start container for

        Returns:
            Error message if failed, None if successful
        """
        # Build task data for executor
        task_data = self._build_sandbox_task(sandbox)

        # Get executor and create container
        executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)

        # Run synchronous executor in thread pool
        result = await asyncio.to_thread(
            executor.submit_executor,
            task_data,
            None,  # No callback for sandbox creation
        )

        if result.get("status") != "success":
            return result.get("error_msg", "Unknown error creating container")

        # Get container name
        container_name = result.get("executor_name", sandbox.container_name)
        sandbox.container_name = container_name

        # Wait for container to be ready and get base_url
        base_url = await self._wait_for_container_ready(executor, container_name)
        if base_url is None:
            return f"Container {container_name} failed to become ready"

        sandbox.set_running(base_url)
        self._repository.save_sandbox(sandbox)

        return None

    async def _wait_for_container_ready(
        self,
        executor,
        container_name: str,
        max_retries: int = 30,
        interval: float = 1.0,
    ) -> Optional[str]:
        """Wait for container to be ready and return base_url.

        Args:
            executor: Executor instance
            container_name: Container/Pod name
            max_retries: Maximum number of retries
            interval: Interval between retries in seconds

        Returns:
            base_url if ready, None otherwise
        """
        for i in range(max_retries):
            result = await asyncio.to_thread(
                executor.get_container_address, container_name
            )
            if result.get("status") == "success":
                base_url = result.get("base_url")
                if base_url:
                    # Check if container is healthy
                    is_healthy = await self._check_container_health(base_url)
                    if is_healthy:
                        logger.info(
                            f"[SandboxManager] Container ready: {container_name}, "
                            f"base_url={base_url}"
                        )
                        return base_url

            logger.debug(
                f"[SandboxManager] Waiting for container {container_name} to be ready "
                f"(attempt {i + 1}/{max_retries})"
            )
            await asyncio.sleep(interval)

        logger.error(
            f"[SandboxManager] Container {container_name} failed to become ready"
        )
        return None

    async def _check_container_health(self, base_url: str) -> bool:
        """Check if container is healthy via HTTP.

        Args:
            base_url: Container base URL (e.g., http://localhost:8080)

        Returns:
            True if healthy, False otherwise
        """
        import httpx

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{base_url}/")
                return response.status_code < 500
        except Exception:
            return False

    def _build_sandbox_task(self, sandbox: Sandbox) -> Dict[str, Any]:
        """Build task data for creating a sandbox container.

        Args:
            sandbox: Sandbox to build task for

        Returns:
            Task data dictionary
        """
        bot_config = sandbox.metadata.get("bot_config", {})

        # Extract task_id and subtask_id from metadata if provided
        # These are used to generate unique container names
        task_id = sandbox.metadata.get("task_id", 0)
        subtask_id = sandbox.metadata.get("subtask_id", 0)

        # Build minimal task structure for sandbox
        # The container will wait for execution requests
        task = {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "task_title": f"Sandbox: {sandbox.sandbox_id[:8]}",
            "subtask_title": "Waiting for executions",
            "type": "sandbox",  # Mark as sandbox type
            "prompt": "",  # Empty prompt - wait for executions
            "status": "PENDING",
            "progress": 0,
            "bot": [
                {
                    "id": 0,
                    "name": f"Sandbox-{sandbox.shell_type}",
                    "shell_type": sandbox.shell_type.lower(),
                    "agent_config": bot_config,
                    "system_prompt": "",
                    "mcp_servers": {},
                    "skills": [],
                    "role": "",
                }
            ],
            "user": {
                "id": sandbox.user_id,
                "name": sandbox.user_name,
            },
            "team_id": 0,
            "git_domain": "",
            "git_repo": "",
            "git_repo_id": 0,
            "branch_name": "",
            "git_url": "",
            "executor_image": self._config.executor.executor_image,
            "sandbox_metadata": {
                "sandbox_id": sandbox.sandbox_id,
                "timeout": (
                    sandbox.expires_at - sandbox.created_at
                    if sandbox.expires_at
                    else self._config.timeout.sandbox_default
                ),
            },
        }

        # Add workspace info if provided
        workspace_ref = sandbox.metadata.get("workspace_ref")
        if workspace_ref:
            task["workspace_ref"] = workspace_ref

        return task

    async def get_sandbox(
        self, sandbox_id: str, check_health: bool = True
    ) -> Optional[Sandbox]:
        """Get sandbox by sandbox_id.

        This method loads sandbox metadata from Redis and optionally checks
        container health via HTTP endpoint.

        Args:
            sandbox_id: Sandbox ID (which is task_id as string)
            check_health: If True (default), check container health via HTTP

        Returns:
            Sandbox if found, None otherwise
        """
        sandbox = self._repository.load_sandbox(sandbox_id)
        if sandbox is None:
            return None

        # Optionally check health via HTTP
        if check_health and sandbox.base_url:
            is_healthy = self._health_checker.check_health_sync(sandbox.base_url)
            if not is_healthy:
                sandbox.status = SandboxStatus.FAILED
                sandbox.base_url = None

        return sandbox

    async def _cleanup_dead_sandbox(self, sandbox: Sandbox) -> None:
        """Clean up a sandbox whose container is no longer alive.

        This is called when health check fails for an existing sandbox.
        It removes the sandbox from Redis so a new one can be created.

        Args:
            sandbox: Sandbox to clean up
        """
        try:
            sandbox_id = sandbox.sandbox_id

            # Try to delete container (might already be gone)
            try:
                executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
                executor.delete_executor(sandbox.container_name)
            except Exception:
                pass  # Container might already be deleted

            # Remove from Redis
            self._repository.delete_sandbox(sandbox_id)

            logger.info(
                f"[SandboxManager] Cleaned up dead sandbox: sandbox_id={sandbox_id}"
            )
        except Exception as e:
            logger.error(f"[SandboxManager] Error cleaning up dead sandbox: {e}")

    async def terminate_sandbox(self, sandbox_id: str) -> Tuple[bool, str]:
        """Terminate a sandbox.

        Args:
            sandbox_id: Sandbox ID (which is task_id as string)

        Returns:
            Tuple of (success, message)
        """
        sandbox = self._repository.load_sandbox(sandbox_id)
        if sandbox is None:
            return False, f"Sandbox {sandbox_id} not found"

        if sandbox.status in [SandboxStatus.TERMINATED, SandboxStatus.TERMINATING]:
            return True, f"Sandbox {sandbox_id} already terminated"

        logger.info(f"[SandboxManager] Terminating sandbox: {sandbox_id}")

        # Mark as terminating
        sandbox.set_terminating()
        self._repository.save_sandbox(sandbox)

        # Delete container
        try:
            executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
            result = executor.delete_executor(sandbox.container_name)
            if result.get("status") != "success":
                logger.warning(
                    f"[SandboxManager] Failed to delete container: {result.get('error_msg')}"
                )
        except Exception as e:
            logger.warning(f"[SandboxManager] Error deleting container: {e}")

        # Mark as terminated
        sandbox.set_terminated()

        # Clean up Redis storage via repository
        self._repository.delete_sandbox(sandbox_id)

        logger.info(f"[SandboxManager] Sandbox terminated: {sandbox_id}")
        return True, f"Sandbox {sandbox_id} terminated successfully"

    async def keep_alive(
        self, sandbox_id: str, additional_timeout: Optional[int] = None
    ) -> Tuple[Optional[Sandbox], Optional[str]]:
        """Extend sandbox timeout.

        Args:
            sandbox_id: Sandbox ID (which is task_id as string)
            additional_timeout: Additional seconds to add (defaults to config)

        Returns:
            Tuple of (updated Sandbox, error_message or None)
        """
        if additional_timeout is None:
            additional_timeout = self._config.timeout.sandbox_default

        sandbox = self._repository.load_sandbox(sandbox_id)
        if sandbox is None:
            return None, f"Sandbox {sandbox_id} not found"

        if not sandbox.is_active():
            return (
                None,
                f"Sandbox {sandbox_id} is not active (status: {sandbox.status.value})",
            )

        sandbox.extend_timeout(additional_timeout)
        self._repository.save_sandbox(sandbox)

        logger.info(
            f"[SandboxManager] Sandbox keep-alive: {sandbox_id}, "
            f"new expiry={sandbox.expires_at}"
        )

        return sandbox, None

    async def pause_sandbox(self, sandbox_id: str) -> Tuple[bool, str]:
        """Pause a running sandbox (E2B standard).

        This pauses the Docker container, preserving its state.

        Args:
            sandbox_id: Sandbox ID (which is task_id as string)

        Returns:
            Tuple of (success, message)
        """
        sandbox = self._repository.load_sandbox(sandbox_id)
        if sandbox is None:
            return False, f"Sandbox {sandbox_id} not found"

        if sandbox.status != SandboxStatus.RUNNING:
            return (
                False,
                f"Sandbox {sandbox_id} is not running (status: {sandbox.status.value})",
            )

        logger.info(f"[SandboxManager] Pausing sandbox: {sandbox_id}")

        try:
            # Pause the Docker container
            from executor_manager.executors.docker.utils import pause_container

            result = pause_container(sandbox.container_name)
            if result.get("status") != "success":
                return False, result.get("error_msg", "Failed to pause container")

            # Update sandbox state
            sandbox.status = SandboxStatus.PENDING  # Use PENDING as "paused" state
            sandbox.metadata["paused"] = True
            sandbox.metadata["paused_at"] = time.time()
            self._repository.save_sandbox(sandbox)

            logger.info(f"[SandboxManager] Sandbox paused: {sandbox_id}")
            return True, f"Sandbox {sandbox_id} paused successfully"

        except Exception as e:
            error_msg = f"Failed to pause sandbox: {str(e)}"
            logger.error(f"[SandboxManager] {error_msg}", exc_info=True)
            return False, error_msg

    async def resume_sandbox(self, sandbox_id: str) -> Tuple[bool, str]:
        """Resume a paused sandbox (E2B standard).

        This unpauses the Docker container.

        Args:
            sandbox_id: Sandbox ID (which is task_id as string)

        Returns:
            Tuple of (success, message)
        """
        sandbox = self._repository.load_sandbox(sandbox_id)
        if sandbox is None:
            return False, f"Sandbox {sandbox_id} not found"

        if not sandbox.metadata.get("paused"):
            return False, f"Sandbox {sandbox_id} is not paused"

        logger.info(f"[SandboxManager] Resuming sandbox: {sandbox_id}")

        try:
            # Unpause the Docker container
            from executor_manager.executors.docker.utils import \
                unpause_container

            result = unpause_container(sandbox.container_name)
            if result.get("status") != "success":
                return False, result.get("error_msg", "Failed to resume container")

            # Update sandbox state
            sandbox.status = SandboxStatus.RUNNING
            sandbox.metadata.pop("paused", None)
            sandbox.metadata.pop("paused_at", None)
            self._repository.save_sandbox(sandbox)

            logger.info(f"[SandboxManager] Sandbox resumed: {sandbox_id}")
            return True, f"Sandbox {sandbox_id} resumed successfully"

        except Exception as e:
            error_msg = f"Failed to resume sandbox: {str(e)}"
            logger.error(f"[SandboxManager] {error_msg}", exc_info=True)
            return False, error_msg

    # =========================================================================
    # Execution Management
    # =========================================================================

    async def create_execution(
        self,
        sandbox_id: str,
        prompt: str,
        timeout: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Optional[Execution], Optional[str]]:
        """Create and start an execution in a sandbox.

        Args:
            sandbox_id: Sandbox ID (which is task_id as string)
            prompt: Task prompt to execute
            timeout: Execution timeout in seconds (defaults to config)
            metadata: Optional additional metadata (should include subtask_id)

        Returns:
            Tuple of (Execution, error_message or None)
        """
        if timeout is None:
            timeout = self._config.timeout.execution_default

        # Load sandbox with health check
        sandbox = await self.get_sandbox(sandbox_id, check_health=True)
        if sandbox is None:
            return None, f"Sandbox {sandbox_id} not found"

        if not sandbox.is_active():
            return (
                None,
                f"Sandbox {sandbox_id} is not active (status: {sandbox.status.value})",
            )

        # Create execution
        exec_metadata = metadata or {}
        exec_metadata["timeout"] = timeout
        # Extract task_id from sandbox_id for metadata
        task_id = int(sandbox_id)
        exec_metadata["task_id"] = task_id
        exec_metadata["sandbox_id"] = sandbox.sandbox_id  # Store for reference

        # Get subtask_id from metadata (required)
        subtask_id = exec_metadata.get("subtask_id")
        if subtask_id is None:
            return None, "subtask_id is required in metadata"

        execution = Execution.create(
            sandbox_id=sandbox.sandbox_id,
            prompt=prompt,
            metadata=exec_metadata,
        )

        # Add to sandbox and save
        sandbox.add_execution(execution)
        self._repository.save_sandbox(sandbox)
        save_result = self._repository.save_execution(execution)

        logger.info(
            f"[SandboxManager] Created execution: execution_id={execution.execution_id}, "
            f"sandbox_id={sandbox_id}, subtask_id={subtask_id}, "
            f"prompt_length={len(prompt)}, save_result={save_result}"
        )

        # Verify execution was saved
        verify_execution = self._repository.load_execution(int(sandbox_id), subtask_id)
        logger.info(
            f"[SandboxManager] Verification: loaded execution = {verify_execution is not None}, "
            f"execution_id={verify_execution.execution_id if verify_execution else 'None'}"
        )

        # Start execution asynchronously using ExecutionRunner
        asyncio.create_task(self._run_execution(sandbox, execution, timeout))

        return execution, None

    async def _run_execution(
        self, sandbox: Sandbox, execution: Execution, timeout: int
    ) -> None:
        """Run an execution in the sandbox container.

        This method uses ExecutionRunner to send the execution request.
        The executor runs the task asynchronously and notifies completion via callback.

        Args:
            sandbox: Sandbox to run in
            execution: Execution to run
            timeout: Timeout in seconds
        """

        def on_running(exec: Execution):
            self._repository.save_execution(exec)

        def on_error(exec: Execution):
            self._repository.save_execution(exec)

        def on_complete(exec: Execution):
            # Update sandbox touch time
            sandbox.touch()
            self._repository.save_sandbox(sandbox)

        success = await self._execution_runner.run_with_timeout(
            sandbox=sandbox,
            execution=execution,
            timeout=timeout,
            on_running=on_running,
            on_complete=on_complete,
            on_error=on_error,
        )

        if success:
            logger.info(
                f"[SandboxManager] Execution accepted: execution_id={execution.execution_id}"
            )
        else:
            logger.info(
                f"[SandboxManager] Execution failed: execution_id={execution.execution_id}, "
                f"status={execution.status.value}, error={execution.error_message}"
            )

    async def get_execution(
        self, sandbox_id: str, subtask_id: int
    ) -> Optional[Execution]:
        """Get execution by subtask ID.

        Args:
            sandbox_id: Sandbox ID (can be task_id string or e2b_sandbox_id)
            subtask_id: Subtask ID

        Returns:
            Execution if found, None otherwise
        """
        logger.info(
            f"[SandboxManager] get_execution: sandbox_id={sandbox_id}, subtask_id={subtask_id}"
        )

        # First try direct lookup assuming sandbox_id is task_id
        try:
            task_id = int(sandbox_id)
            logger.info(f"[SandboxManager] Trying direct lookup with task_id={task_id}")
            execution = self._repository.load_execution(task_id, subtask_id)
            if execution:
                logger.info(f"[SandboxManager] Found execution by task_id={task_id}")
                return execution
            logger.info(
                f"[SandboxManager] No execution found for task_id={task_id}, subtask_id={subtask_id}"
            )
        except ValueError:
            # sandbox_id is not numeric, might be e2b_sandbox_id
            logger.info(
                f"[SandboxManager] sandbox_id is not numeric, trying e2b_sandbox_id lookup"
            )

        # Fallback: search by e2b_sandbox_id in metadata
        sandbox_ids = self._repository.get_active_sandbox_ids()
        logger.info(
            f"[SandboxManager] Searching in {len(sandbox_ids)} active sandboxes"
        )

        for sid in sandbox_ids:
            sandbox = self._repository.load_sandbox(sid)
            if sandbox:
                e2b_id = sandbox.metadata.get("e2b_sandbox_id")
                logger.debug(
                    f"[SandboxManager] Checking sandbox sid={sid}, e2b_sandbox_id={e2b_id}"
                )
                if e2b_id == sandbox_id:
                    # Found matching sandbox, load execution by its task_id
                    task_id = sandbox.metadata.get("task_id")
                    logger.info(
                        f"[SandboxManager] Found matching sandbox, task_id={task_id}"
                    )
                    if task_id:
                        return self._repository.load_execution(int(task_id), subtask_id)

        logger.info(
            f"[SandboxManager] No matching sandbox found for sandbox_id={sandbox_id}"
        )
        return None

    async def list_executions(
        self, sandbox_id: str
    ) -> Tuple[List[Execution], Optional[str]]:
        """List all executions in a sandbox.

        Args:
            sandbox_id: Sandbox ID (can be task_id string or e2b_sandbox_id)

        Returns:
            Tuple of (list of Executions, error_message or None)
        """
        # First try direct lookup assuming sandbox_id is task_id
        try:
            int(sandbox_id)  # Validate it's numeric
            executions, error = self._repository.list_executions(sandbox_id)
            # If found data or explicit error, return it
            if executions or error != f"Sandbox {sandbox_id} not found":
                return executions, error
        except ValueError:
            pass

        # Fallback: search by e2b_sandbox_id in metadata
        sandbox_ids = self._repository.get_active_sandbox_ids()
        for sid in sandbox_ids:
            sandbox = self._repository.load_sandbox(sid)
            if sandbox and sandbox.metadata.get("e2b_sandbox_id") == sandbox_id:
                # Found matching sandbox, list executions by its task_id
                task_id = sandbox.metadata.get("task_id")
                if task_id:
                    return self._repository.list_executions(str(task_id))

        return [], f"Sandbox {sandbox_id} not found"

    # =========================================================================
    # Scheduled Tasks (delegated to SandboxScheduler)
    # =========================================================================

    async def start_scheduler(self) -> None:
        """Start the background task scheduler."""
        if self._scheduler is not None and self._scheduler.is_running:
            logger.warning("[SandboxManager] Scheduler is already running")
            return

        # Import here to avoid circular imports
        from executor_manager.services.sandbox.scheduler import \
            SandboxScheduler

        self._scheduler = SandboxScheduler(self)
        await self._scheduler.start()

    async def stop_scheduler(self) -> None:
        """Stop the background task scheduler."""
        self._shutting_down = True
        if self._scheduler is not None:
            await self._scheduler.stop()
            self._scheduler = None

    # Legacy method names for backward compatibility
    async def start_gc_task(self) -> None:
        """Start background tasks. (Alias for start_scheduler)"""
        await self.start_scheduler()

    async def stop_gc_task(self) -> None:
        """Stop background tasks. (Alias for stop_scheduler)"""
        await self.stop_scheduler()

    # =========================================================================
    # Background Task Implementations (called by SandboxScheduler)
    # =========================================================================

    async def _check_heartbeats(self) -> None:
        """Check heartbeat status for all active sandboxes.

        If a sandbox has not received a heartbeat within timeout,
        mark it as failed and update execution status.
        """
        task_ids = self._repository.get_active_sandbox_ids()
        if not task_ids:
            return

        heartbeat_mgr = get_heartbeat_manager()
        # Grace period from environment, default 30s (container startup time)
        grace_period = int(os.getenv("HEARTBEAT_GRACE_PERIOD", "30"))

        for task_id_str in task_ids:
            try:
                sandbox = self._repository.load_sandbox(task_id_str)
                if sandbox is None or sandbox.status != SandboxStatus.RUNNING:
                    continue

                # Check heartbeat - returns False if key missing or expired
                if not heartbeat_mgr.check_heartbeat(task_id_str):
                    # Get last heartbeat time (may be None if key expired)
                    last_heartbeat = heartbeat_mgr.get_last_heartbeat(task_id_str)

                    # Check if sandbox has been running long enough to expect heartbeat
                    # Grace period: sandbox needs some time to start sending heartbeats
                    sandbox_age = time.time() - sandbox.created_at

                    if sandbox_age > grace_period:
                        # Sandbox is old enough - missing heartbeat means dead
                        # Note: last_heartbeat may be None if key already expired from Redis
                        logger.warning(
                            f"[SandboxManager] Heartbeat timeout for sandbox {task_id_str}, "
                            f"age={sandbox_age:.1f}s, last_heartbeat={last_heartbeat}"
                        )
                        await self._handle_executor_dead(
                            task_id_str, last_heartbeat or sandbox.last_activity_at
                        )

            except Exception as e:
                logger.debug(
                    f"[SandboxManager] Heartbeat check error for {task_id_str}: {e}"
                )
                continue

    async def _handle_executor_dead(
        self, sandbox_id: str, last_heartbeat: float
    ) -> None:
        """Handle executor container death.

        Marks the sandbox as failed and all running executions as failed.
        Does NOT delete sandbox data immediately - lets GC handle cleanup later
        so clients can still poll for execution status.

        Args:
            sandbox_id: Sandbox ID (task_id as string)
            last_heartbeat: Last heartbeat timestamp
        """
        logger.warning(
            f"[SandboxManager] Handling executor death: sandbox_id={sandbox_id}"
        )

        heartbeat_mgr = get_heartbeat_manager()

        # Mark all running executions as failed
        try:
            executions, _ = await self.list_executions(sandbox_id)
            for execution in executions:
                if execution.status == ExecutionStatus.RUNNING:
                    execution.set_failed("SubAgent crashed")
                    self._repository.save_execution(execution)
                    logger.info(
                        f"[SandboxManager] Marked execution {execution.execution_id} as failed "
                        f"due to executor death"
                    )
        except Exception as e:
            logger.error(f"[SandboxManager] Error marking executions as failed: {e}")

        # Clean up heartbeat key
        heartbeat_mgr.delete_heartbeat(sandbox_id)

        # Mark sandbox as failed but don't delete data yet
        # This allows clients to poll for execution status
        # GC will clean up the data later
        sandbox = self._repository.load_sandbox(sandbox_id)
        if sandbox:
            sandbox.set_failed("SubAgent crashed")
            self._repository.save_sandbox(sandbox)
            # Remove from active set to prevent repeated heartbeat checks
            self._repository.remove_from_active_set(sandbox_id)
            logger.info(
                f"[SandboxManager] Marked sandbox {sandbox_id} as failed, "
                "data preserved for client polling"
            )

            # Try to delete container (but don't delete Redis data)
            try:
                executor = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE)
                result = executor.delete_executor(sandbox.container_name)
                if result.get("status") != "success":
                    logger.warning(
                        f"[SandboxManager] Failed to delete container: {result.get('error_msg')}"
                    )
            except Exception as e:
                logger.warning(f"[SandboxManager] Error deleting container: {e}")

    async def _terminate_expired_sandbox(self, task_id_str: str) -> None:
        """Terminate a single expired sandbox.

        Args:
            task_id_str: Task ID as string
        """
        sandbox = self._repository.load_sandbox(task_id_str)
        if sandbox is None:
            # Clean up orphaned ZSet entry
            self._repository.remove_from_active_set(task_id_str)
            logger.debug(f"[SandboxManager] Cleaned orphaned ZSet entry: {task_id_str}")
            return

        logger.info(
            f"[SandboxManager] Terminating expired sandbox: {sandbox.sandbox_id}, "
            f"last_activity={sandbox.last_activity_at}"
        )
        await self.terminate_sandbox(task_id_str)

    async def _collect_expired_sandboxes(self) -> None:
        """Terminate expired sandboxes.

        Uses repository to efficiently find sandboxes whose last_activity_timestamp
        is older than the configured TTL.
        """
        lock = get_distributed_lock()
        if not lock.acquire("sandbox_gc", expire_seconds=300):
            logger.info(
                "[SandboxManager] Sandbox GC already running on another instance, skipping"
            )
            return

        try:
            logger.info("[SandboxManager] Running sandbox GC...")
            expired_task_ids = self._repository.get_expired_sandbox_ids(
                self._config.timeout.redis_ttl
            )

            if not expired_task_ids:
                logger.info("[SandboxManager] No expired sandboxes found")
                return

            logger.info(
                f"[SandboxManager] Found {len(expired_task_ids)} expired sandboxes to clean up"
            )

            for task_id_str in expired_task_ids:
                try:
                    await self._terminate_expired_sandbox(task_id_str)
                except Exception as e:
                    logger.warning(
                        f"[SandboxManager] Failed to terminate expired sandbox {task_id_str}: {e}"
                    )
        finally:
            lock.release("sandbox_gc")


def get_sandbox_manager() -> SandboxManager:
    """Get the global SandboxManager instance.

    Returns:
        The SandboxManager singleton
    """
    return SandboxManager()
