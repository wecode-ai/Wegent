# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox and Execution models for E2B-like API.

This module defines the core data models for sandbox lifecycle management
following the E2B (Execution Box) protocol pattern.

Key Concepts:
- Sandbox: An isolated execution environment (Docker container)
- Execution: A task execution within a sandbox
- SandboxStatus: Lifecycle states for sandboxes
- ExecutionStatus: Lifecycle states for executions
"""

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class SandboxStatus(str, Enum):
    """Sandbox lifecycle states (following K8s Pod status pattern).

    States:
        PENDING: Sandbox is being provisioned (container not yet running)
        RUNNING: Sandbox is active and ready for executions
        SUCCEEDED: Sandbox completed successfully (not commonly used)
        FAILED: Sandbox failed to start or crashed
        TERMINATING: Sandbox is being shut down
        TERMINATED: Sandbox has been terminated
    """

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TERMINATING = "terminating"
    TERMINATED = "terminated"


class ExecutionStatus(str, Enum):
    """Execution lifecycle states.

    States:
        PENDING: Execution is queued
        RUNNING: Execution is in progress
        COMPLETED: Execution finished successfully
        FAILED: Execution failed with error
        CANCELLED: Execution was cancelled
        TIMEOUT: Execution exceeded time limit
    """

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


@dataclass
class Execution:
    """Represents a task execution within a sandbox.

    Attributes:
        execution_id: Unique identifier for this execution
        sandbox_id: ID of the parent sandbox
        prompt: The task prompt/command to execute
        status: Current execution status
        result: Execution output (if completed)
        error_message: Error details (if failed)
        created_at: Timestamp when execution was created
        started_at: Timestamp when execution started running
        completed_at: Timestamp when execution completed
        progress: Execution progress percentage (0-100)
        metadata: Additional execution metadata
    """

    execution_id: str
    sandbox_id: str
    prompt: str
    status: ExecutionStatus = ExecutionStatus.PENDING
    result: Optional[str] = None
    error_message: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    progress: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def create(
        cls,
        sandbox_id: str,
        prompt: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> "Execution":
        """Create a new execution instance.

        Args:
            sandbox_id: ID of the parent sandbox
            prompt: Task prompt to execute
            metadata: Optional additional metadata

        Returns:
            New Execution instance with generated ID
        """
        return cls(
            execution_id=str(uuid.uuid4()),
            sandbox_id=sandbox_id,
            prompt=prompt,
            metadata=metadata or {},
        )

    def set_running(self) -> None:
        """Mark execution as running."""
        self.status = ExecutionStatus.RUNNING
        self.started_at = time.time()

    def set_completed(self, result: str) -> None:
        """Mark execution as completed with result.

        Args:
            result: Execution output
        """
        self.status = ExecutionStatus.COMPLETED
        self.result = result
        self.completed_at = time.time()
        self.progress = 100

    def set_failed(self, error_message: str) -> None:
        """Mark execution as failed with error.

        Args:
            error_message: Error description
        """
        self.status = ExecutionStatus.FAILED
        self.error_message = error_message
        self.completed_at = time.time()

    def set_cancelled(self) -> None:
        """Mark execution as cancelled."""
        self.status = ExecutionStatus.CANCELLED
        self.completed_at = time.time()

    def set_timeout(self) -> None:
        """Mark execution as timed out."""
        self.status = ExecutionStatus.TIMEOUT
        self.error_message = "Execution timed out"
        self.completed_at = time.time()

    def update_progress(self, progress: int) -> None:
        """Update execution progress.

        Args:
            progress: Progress percentage (0-100)
        """
        self.progress = min(max(0, progress), 100)

    @property
    def execution_time(self) -> Optional[float]:
        """Calculate execution time in seconds.

        Returns:
            Execution time if started, None otherwise
        """
        if self.started_at is None:
            return None
        end_time = self.completed_at or time.time()
        return end_time - self.started_at

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary representation.

        Returns:
            Dictionary with all execution data
        """
        return {
            "execution_id": self.execution_id,
            "sandbox_id": self.sandbox_id,
            "prompt": self.prompt,
            "status": self.status.value,
            "result": self.result,
            "error_message": self.error_message,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "progress": self.progress,
            "execution_time": self.execution_time,
            "metadata": self.metadata,
        }


@dataclass
class Sandbox:
    """Represents an isolated execution environment (Docker container).

    Attributes:
        sandbox_id: Unique identifier for this sandbox
        container_name: Docker container name
        shell_type: Execution environment type (ClaudeCode, Agno)
        status: Current sandbox status
        user_id: ID of the user who created the sandbox
        user_name: Username of the creator
        port: Host port mapped to container
        created_at: Timestamp when sandbox was created
        started_at: Timestamp when sandbox became running
        last_activity_at: Timestamp of last activity (for timeout)
        expires_at: Timestamp when sandbox will auto-terminate
        error_message: Error details (if failed)
        metadata: Additional sandbox metadata (workspace_ref, bot_config, etc.)
        executions: List of executions in this sandbox
    """

    sandbox_id: str
    container_name: str
    shell_type: str
    status: SandboxStatus = SandboxStatus.PENDING
    user_id: int = 0
    user_name: str = ""
    base_url: Optional[str] = None  # Container base URL (e.g., http://localhost:8080)
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    last_activity_at: float = field(default_factory=time.time)
    expires_at: Optional[float] = None
    error_message: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    executions: List[Execution] = field(default_factory=list)

    # Default timeout in seconds (30 minutes)
    DEFAULT_TIMEOUT = 1800

    @classmethod
    def create(
        cls,
        shell_type: str,
        user_id: int,
        user_name: str,
        timeout: int = DEFAULT_TIMEOUT,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> "Sandbox":
        """Create a new sandbox instance.

        Args:
            shell_type: Execution environment type (ClaudeCode, Agno)
            user_id: User ID
            user_name: Username
            timeout: Sandbox timeout in seconds
            metadata: Optional additional metadata (should include task_id)

        Returns:
            New Sandbox instance with sandbox_id derived from task_id
        """
        # Get task_id from metadata to use as sandbox_id
        task_id = (metadata or {}).get("task_id")
        if task_id is None:
            raise ValueError("task_id is required in metadata")

        # Use task_id as sandbox_id (convert to string)
        sandbox_id = str(task_id)

        now = time.time()
        return cls(
            sandbox_id=sandbox_id,
            container_name=f"wegent-task-{user_name}-{sandbox_id[:8]}",
            shell_type=shell_type,
            user_id=user_id,
            user_name=user_name,
            created_at=now,
            last_activity_at=now,
            expires_at=now + timeout,
            metadata=metadata or {},
        )

    def set_running(self, base_url: str) -> None:
        """Mark sandbox as running.

        Args:
            base_url: Container base URL (e.g., http://localhost:8080)
        """
        self.status = SandboxStatus.RUNNING
        self.base_url = base_url
        self.started_at = time.time()
        self.touch()

    def set_failed(self, error_message: str) -> None:
        """Mark sandbox as failed.

        Args:
            error_message: Error description
        """
        self.status = SandboxStatus.FAILED
        self.error_message = error_message

    def set_terminating(self) -> None:
        """Mark sandbox as terminating."""
        self.status = SandboxStatus.TERMINATING

    def set_terminated(self) -> None:
        """Mark sandbox as terminated."""
        self.status = SandboxStatus.TERMINATED

    def touch(self) -> None:
        """Update last activity timestamp."""
        self.last_activity_at = time.time()

    def extend_timeout(self, additional_seconds: int) -> None:
        """Extend sandbox timeout.

        Args:
            additional_seconds: Additional time in seconds
        """
        now = time.time()
        # Extend from current time, not from original expiry
        self.expires_at = now + additional_seconds
        self.touch()

    def is_expired(self) -> bool:
        """Check if sandbox has expired.

        Returns:
            True if sandbox has exceeded timeout
        """
        if self.expires_at is None:
            return False
        return time.time() > self.expires_at

    def is_active(self) -> bool:
        """Check if sandbox is active (can accept executions).

        Returns:
            True if sandbox is running and not expired
        """
        return self.status == SandboxStatus.RUNNING and not self.is_expired()

    def add_execution(self, execution: Execution) -> None:
        """Add an execution to this sandbox.

        Args:
            execution: Execution to add
        """
        self.executions.append(execution)
        self.touch()

    def get_execution(self, execution_id: str) -> Optional[Execution]:
        """Get execution by ID.

        Args:
            execution_id: Execution ID to find

        Returns:
            Execution if found, None otherwise
        """
        for execution in self.executions:
            if execution.execution_id == execution_id:
                return execution
        return None

    @property
    def uptime(self) -> Optional[float]:
        """Calculate sandbox uptime in seconds.

        Returns:
            Uptime if running, None otherwise
        """
        if self.started_at is None:
            return None
        return time.time() - self.started_at

    @property
    def time_remaining(self) -> Optional[float]:
        """Calculate remaining time before expiry.

        Returns:
            Remaining seconds, negative if expired, None if no expiry set
        """
        if self.expires_at is None:
            return None
        return self.expires_at - time.time()

    def to_dict(self, include_executions: bool = False) -> Dict[str, Any]:
        """Convert to dictionary representation.

        Args:
            include_executions: Whether to include execution details

        Returns:
            Dictionary with sandbox data
        """
        data = {
            "sandbox_id": self.sandbox_id,
            "container_name": self.container_name,
            "shell_type": self.shell_type,
            "status": self.status.value,
            "user_id": self.user_id,
            "user_name": self.user_name,
            "base_url": self.base_url,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "last_activity_at": self.last_activity_at,
            "expires_at": self.expires_at,
            "error_message": self.error_message,
            "uptime": self.uptime,
            "time_remaining": self.time_remaining,
            "metadata": self.metadata,
            "execution_count": len(self.executions),
        }

        if include_executions:
            data["executions"] = [e.to_dict() for e in self.executions]

        return data
