# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox client for executing code in isolated containers.

This module provides the SandboxClient class that communicates with
executor_manager's sandbox API to execute code in isolated Docker containers.

The client manages sandbox lifecycle:
- Create sandbox on first use
- Reuse sandbox for subsequent operations within the same task
- Poll for execution completion
- Clean up sandbox when done
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

# Default configuration
DEFAULT_SANDBOX_TIMEOUT = 1800  # 30 minutes
DEFAULT_EXECUTION_TIMEOUT = 300  # 5 minutes
DEFAULT_POLL_INTERVAL = 1.0  # 1 second
MAX_POLL_ATTEMPTS = 600  # 10 minutes max polling


@dataclass
class SandboxExecutionResult:
    """Result of a sandbox execution.

    Attributes:
        success: Whether the execution succeeded
        result: Execution result (if successful)
        error: Error message (if failed)
        execution_time: Time taken for execution in seconds
        status: Final execution status
    """

    success: bool
    result: Optional[str] = None
    error: Optional[str] = None
    execution_time: Optional[float] = None
    status: str = "unknown"


@dataclass
class SandboxClient:
    """Client for interacting with executor_manager sandbox API.

    This client manages the lifecycle of a sandbox container and provides
    methods to execute code within it. The sandbox is created lazily on
    first use and reused for subsequent operations.

    Attributes:
        executor_manager_url: Base URL of executor_manager service
        task_id: Task ID for sandbox identification
        user_id: User ID for access control
        user_name: Username for logging
        shell_type: Shell type for sandbox (default: "ClaudeCode")
        sandbox_timeout: Sandbox timeout in seconds
        auth_token: Optional authentication token
    """

    executor_manager_url: str
    task_id: int
    user_id: int
    user_name: str = ""
    shell_type: str = "ClaudeCode"
    sandbox_timeout: int = DEFAULT_SANDBOX_TIMEOUT
    auth_token: str = ""

    # Internal state
    _sandbox_id: Optional[str] = field(default=None, init=False)
    _sandbox_status: str = field(default="unknown", init=False)
    _http_client: Optional[httpx.AsyncClient] = field(default=None, init=False)

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=60.0)
        return self._http_client

    def _get_headers(self) -> dict[str, str]:
        """Get HTTP headers with authentication."""
        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        return headers

    async def ensure_sandbox(self) -> tuple[str, Optional[str]]:
        """Ensure a sandbox exists for this task, create if needed.

        Returns:
            Tuple of (sandbox_id, error_message or None)
        """
        # Check if sandbox already exists
        if self._sandbox_id and self._sandbox_status == "running":
            logger.debug(
                f"[SandboxClient] Reusing existing sandbox: {self._sandbox_id}"
            )
            return self._sandbox_id, None

        # Try to get existing sandbox by task_id
        sandbox_id = str(self.task_id)
        existing = await self._get_sandbox(sandbox_id)
        if existing and existing.get("status") == "running":
            self._sandbox_id = sandbox_id
            self._sandbox_status = "running"
            logger.info(f"[SandboxClient] Found existing sandbox: {sandbox_id}")
            return sandbox_id, None

        # Create new sandbox
        logger.info(f"[SandboxClient] Creating new sandbox for task {self.task_id}")
        return await self._create_sandbox()

    async def _get_sandbox(self, sandbox_id: str) -> Optional[dict[str, Any]]:
        """Get sandbox status by ID.

        Args:
            sandbox_id: Sandbox ID to query

        Returns:
            Sandbox status dict or None if not found
        """
        try:
            client = await self._get_client()
            url = f"{self.executor_manager_url}/executor-manager/sandboxes/{sandbox_id}"
            response = await client.get(url, headers=self._get_headers())

            if response.status_code == 404:
                return None

            response.raise_for_status()
            return response.json()

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return None
            logger.warning(f"[SandboxClient] Failed to get sandbox {sandbox_id}: {e}")
            return None
        except Exception as e:
            logger.warning(f"[SandboxClient] Error getting sandbox {sandbox_id}: {e}")
            return None

    async def _create_sandbox(self) -> tuple[str, Optional[str]]:
        """Create a new sandbox.

        Returns:
            Tuple of (sandbox_id, error_message or None)
        """
        try:
            client = await self._get_client()
            url = f"{self.executor_manager_url}/executor-manager/sandboxes"

            payload = {
                "shell_type": self.shell_type,
                "user_id": self.user_id,
                "user_name": self.user_name or "unknown",
                "timeout": self.sandbox_timeout,
                "metadata": {
                    "task_id": self.task_id,
                    "source": "chat_shell",
                },
            }

            response = await client.post(url, json=payload, headers=self._get_headers())
            response.raise_for_status()

            data = response.json()
            sandbox_id = data.get("sandbox_id")
            status = data.get("status")

            if status == "failed":
                error = data.get("message", "Sandbox creation failed")
                logger.error(f"[SandboxClient] Sandbox creation failed: {error}")
                return "", error

            self._sandbox_id = sandbox_id
            self._sandbox_status = status

            logger.info(
                f"[SandboxClient] Created sandbox: {sandbox_id}, status={status}"
            )

            # Wait for sandbox to be ready
            if status != "running":
                ready, error = await self._wait_for_sandbox_ready(sandbox_id)
                if not ready:
                    return sandbox_id, error

            return sandbox_id, None

        except httpx.HTTPStatusError as e:
            error = f"HTTP error creating sandbox: {e.response.status_code}"
            logger.error(f"[SandboxClient] {error}")
            return "", error
        except Exception as e:
            error = f"Error creating sandbox: {str(e)}"
            logger.error(f"[SandboxClient] {error}")
            return "", error

    async def _wait_for_sandbox_ready(
        self, sandbox_id: str, timeout: float = 120.0
    ) -> tuple[bool, Optional[str]]:
        """Wait for sandbox to be ready.

        Args:
            sandbox_id: Sandbox ID to wait for
            timeout: Maximum time to wait in seconds

        Returns:
            Tuple of (is_ready, error_message or None)
        """
        start_time = time.time()
        poll_interval = 2.0

        while time.time() - start_time < timeout:
            status = await self._get_sandbox(sandbox_id)
            if status is None:
                return False, "Sandbox not found"

            sandbox_status = status.get("status")
            if sandbox_status == "running":
                self._sandbox_status = "running"
                logger.info(f"[SandboxClient] Sandbox {sandbox_id} is ready")
                return True, None
            elif sandbox_status == "failed":
                error = status.get("error_message", "Sandbox failed to start")
                return False, error

            await asyncio.sleep(poll_interval)

        return False, "Timeout waiting for sandbox to be ready"

    async def execute(
        self,
        prompt: str,
        timeout: int = DEFAULT_EXECUTION_TIMEOUT,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SandboxExecutionResult:
        """Execute a prompt in the sandbox and wait for result.

        Args:
            prompt: The prompt/code to execute
            timeout: Execution timeout in seconds
            metadata: Optional metadata for the execution

        Returns:
            SandboxExecutionResult with execution outcome
        """
        start_time = time.time()

        # Ensure sandbox exists
        sandbox_id, error = await self.ensure_sandbox()
        if error:
            return SandboxExecutionResult(
                success=False,
                error=f"Failed to create sandbox: {error}",
                status="failed",
            )

        # Start execution
        execution_id, subtask_id, error = await self._start_execution(
            sandbox_id, prompt, timeout, metadata
        )
        if error:
            return SandboxExecutionResult(
                success=False,
                error=f"Failed to start execution: {error}",
                status="failed",
            )

        # Poll for completion
        result = await self._poll_execution(sandbox_id, subtask_id, timeout)
        result.execution_time = time.time() - start_time

        return result

    async def _start_execution(
        self,
        sandbox_id: str,
        prompt: str,
        timeout: int,
        metadata: Optional[dict[str, Any]] = None,
    ) -> tuple[str, int, Optional[str]]:
        """Start an execution in the sandbox.

        Args:
            sandbox_id: Sandbox ID
            prompt: Prompt to execute
            timeout: Execution timeout
            metadata: Optional metadata

        Returns:
            Tuple of (execution_id, subtask_id, error_message or None)
        """
        try:
            client = await self._get_client()
            url = f"{self.executor_manager_url}/executor-manager/sandboxes/{sandbox_id}/execute"

            payload = {
                "prompt": prompt,
                "timeout": timeout,
                "metadata": metadata or {},
            }

            response = await client.post(url, json=payload, headers=self._get_headers())
            response.raise_for_status()

            data = response.json()
            execution_id = data.get("execution_id", "")

            # Extract subtask_id from metadata or execution_id
            subtask_id = (
                data.get("metadata", {}).get("subtask_id") or metadata.get("subtask_id")
                if metadata
                else None
            )
            if subtask_id is None:
                # Use a hash of execution_id as subtask_id
                subtask_id = hash(execution_id) % (10**9)

            logger.info(
                f"[SandboxClient] Started execution: {execution_id}, "
                f"subtask_id={subtask_id}"
            )

            return execution_id, subtask_id, None

        except httpx.HTTPStatusError as e:
            error = f"HTTP error starting execution: {e.response.status_code}"
            logger.error(f"[SandboxClient] {error}")
            return "", 0, error
        except Exception as e:
            error = f"Error starting execution: {str(e)}"
            logger.error(f"[SandboxClient] {error}")
            return "", 0, error

    async def _poll_execution(
        self,
        sandbox_id: str,
        subtask_id: int,
        timeout: int,
    ) -> SandboxExecutionResult:
        """Poll for execution completion.

        Args:
            sandbox_id: Sandbox ID
            subtask_id: Subtask ID to poll
            timeout: Maximum time to wait

        Returns:
            SandboxExecutionResult with execution outcome
        """
        start_time = time.time()
        poll_interval = DEFAULT_POLL_INTERVAL

        while time.time() - start_time < timeout:
            try:
                client = await self._get_client()
                url = (
                    f"{self.executor_manager_url}/executor-manager/sandboxes/"
                    f"{sandbox_id}/executions/{subtask_id}"
                )

                response = await client.get(url, headers=self._get_headers())
                response.raise_for_status()

                data = response.json()
                status = data.get("status", "unknown")

                if status == "completed":
                    return SandboxExecutionResult(
                        success=True,
                        result=data.get("result"),
                        status=status,
                    )
                elif status == "failed":
                    return SandboxExecutionResult(
                        success=False,
                        error=data.get("error_message", "Execution failed"),
                        status=status,
                    )
                elif status in ("cancelled", "timeout"):
                    return SandboxExecutionResult(
                        success=False,
                        error=f"Execution {status}",
                        status=status,
                    )

                # Still running, continue polling
                await asyncio.sleep(poll_interval)

            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    # Execution not found yet, retry
                    await asyncio.sleep(poll_interval)
                    continue
                logger.warning(f"[SandboxClient] Error polling execution: {e}")
                await asyncio.sleep(poll_interval)
            except Exception as e:
                logger.warning(f"[SandboxClient] Error polling execution: {e}")
                await asyncio.sleep(poll_interval)

        return SandboxExecutionResult(
            success=False,
            error="Execution timeout",
            status="timeout",
        )

    async def terminate(self) -> tuple[bool, Optional[str]]:
        """Terminate the sandbox.

        Returns:
            Tuple of (success, error_message or None)
        """
        if not self._sandbox_id:
            return True, None

        try:
            client = await self._get_client()
            url = (
                f"{self.executor_manager_url}/executor-manager/sandboxes/"
                f"{self._sandbox_id}"
            )

            response = await client.delete(url, headers=self._get_headers())
            response.raise_for_status()

            logger.info(f"[SandboxClient] Terminated sandbox: {self._sandbox_id}")

            self._sandbox_id = None
            self._sandbox_status = "terminated"

            return True, None

        except httpx.HTTPStatusError as e:
            error = f"HTTP error terminating sandbox: {e.response.status_code}"
            logger.error(f"[SandboxClient] {error}")
            return False, error
        except Exception as e:
            error = f"Error terminating sandbox: {str(e)}"
            logger.error(f"[SandboxClient] {error}")
            return False, error

    async def keep_alive(
        self, additional_timeout: int = DEFAULT_SANDBOX_TIMEOUT
    ) -> tuple[bool, Optional[str]]:
        """Extend sandbox timeout.

        Args:
            additional_timeout: Additional seconds to add

        Returns:
            Tuple of (success, error_message or None)
        """
        if not self._sandbox_id:
            return False, "No sandbox to keep alive"

        try:
            client = await self._get_client()
            url = (
                f"{self.executor_manager_url}/executor-manager/sandboxes/"
                f"{self._sandbox_id}/keep-alive"
            )

            payload = {"timeout": additional_timeout}

            response = await client.post(url, json=payload, headers=self._get_headers())
            response.raise_for_status()

            logger.info(f"[SandboxClient] Extended sandbox timeout: {self._sandbox_id}")

            return True, None

        except httpx.HTTPStatusError as e:
            error = f"HTTP error extending timeout: {e.response.status_code}"
            logger.error(f"[SandboxClient] {error}")
            return False, error
        except Exception as e:
            error = f"Error extending timeout: {str(e)}"
            logger.error(f"[SandboxClient] {error}")
            return False, error

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None

    @property
    def sandbox_id(self) -> Optional[str]:
        """Get current sandbox ID."""
        return self._sandbox_id

    @property
    def is_ready(self) -> bool:
        """Check if sandbox is ready for execution."""
        return self._sandbox_id is not None and self._sandbox_status == "running"
