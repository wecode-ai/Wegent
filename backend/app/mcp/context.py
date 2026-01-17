# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Context management for MCP interactive tools.

This module provides mechanisms for injecting and retrieving task context
within MCP tool calls.
"""

import logging
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

# Context variable to store the current task context
_task_context: ContextVar[Optional["TaskContext"]] = ContextVar("task_context", default=None)


@dataclass
class TaskContext:
    """Context information for the current MCP tool execution."""

    task_id: int
    subtask_id: Optional[int] = None
    user_id: Optional[int] = None


def get_task_context() -> Optional[TaskContext]:
    """
    Get the current task context.

    Returns:
        TaskContext if set, None otherwise
    """
    return _task_context.get()


def set_task_context(context: TaskContext) -> None:
    """
    Set the current task context.

    Args:
        context: TaskContext to set
    """
    _task_context.set(context)
    logger.debug(f"[MCP] Task context set: task_id={context.task_id}")


def clear_task_context() -> None:
    """Clear the current task context."""
    _task_context.set(None)
    logger.debug("[MCP] Task context cleared")


class TaskContextManager:
    """Context manager for task context."""

    def __init__(self, task_id: int, subtask_id: Optional[int] = None, user_id: Optional[int] = None):
        self.context = TaskContext(task_id=task_id, subtask_id=subtask_id, user_id=user_id)
        self._token = None

    def __enter__(self) -> TaskContext:
        self._token = _task_context.set(self.context)
        return self.context

    def __exit__(self, exc_type, exc_val, exc_tb):
        _task_context.reset(self._token)
        return False


def get_task_id() -> Optional[int]:
    """
    Convenience function to get the current task ID.

    Returns:
        Task ID if context is set, None otherwise
    """
    ctx = get_task_context()
    return ctx.task_id if ctx else None
