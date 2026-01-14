# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox service module.

This module provides E2B-like sandbox execution capabilities:
- Sandbox lifecycle management (create, get, terminate)
- Execution management within sandboxes
- Container health checking
- Background scheduling for cleanup tasks

Public API:
    - SandboxManager: Main service for sandbox operations
    - get_sandbox_manager(): Get the singleton SandboxManager instance
    - SandboxScheduler: Background scheduler for sandbox maintenance
"""

from executor_manager.services.sandbox.execution_runner import (
    ExecutionRunner, get_execution_runner)
from executor_manager.services.sandbox.health_checker import (
    ContainerHealthChecker, get_container_health_checker)
from executor_manager.services.sandbox.manager import (SandboxManager,
                                                       get_sandbox_manager)
from executor_manager.services.sandbox.repository import (
    SandboxRepository, get_sandbox_repository)
from executor_manager.services.sandbox.scheduler import SandboxScheduler

__all__ = [
    "SandboxManager",
    "get_sandbox_manager",
    "SandboxScheduler",
    "ContainerHealthChecker",
    "get_container_health_checker",
    "ExecutionRunner",
    "get_execution_runner",
    "SandboxRepository",
    "get_sandbox_repository",
]
