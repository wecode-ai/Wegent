# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for mutating Task CRD status fields."""

from datetime import datetime
from typing import Optional

from sqlalchemy.orm.attributes import flag_modified

from app.models.task import TaskResource


def mark_task_pending(task: TaskResource) -> None:
    """Reset a task CRD to PENDING before dispatching new work."""
    task_json = task.json or {}
    status = task_json.setdefault("status", {})
    now = datetime.now().isoformat()

    status["status"] = "PENDING"
    status["progress"] = 0
    status["errorMessage"] = ""
    status["updatedAt"] = now
    status["completedAt"] = None

    task.json = task_json
    task.updated_at = datetime.now()
    try:
        flag_modified(task, "json")
    except Exception:
        pass


def mark_task_failed(task: TaskResource, error_message: str) -> None:
    """Persist a terminal prepare/recovery failure on a task CRD."""
    task_json = task.json or {}
    status = task_json.setdefault("status", {})
    now = datetime.now().isoformat()

    status["status"] = "FAILED"
    status["progress"] = 100
    status["errorMessage"] = error_message
    status["updatedAt"] = now
    status["completedAt"] = now

    task.json = task_json
    task.updated_at = datetime.now()
    try:
        flag_modified(task, "json")
    except Exception:
        pass


def extract_task_error(task: TaskResource) -> Optional[str]:
    """Return the current task-level error message if present."""
    status = (task.json or {}).get("status", {})
    error_message = status.get("errorMessage")
    if isinstance(error_message, str) and error_message.strip():
        return error_message.strip()
    return None
