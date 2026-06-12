# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for mutating Task CRD status fields."""

from copy import deepcopy
from datetime import datetime
from typing import Any, Optional


def mark_task_pending_payload(task_json: dict[str, Any] | None) -> dict[str, Any]:
    """Return task CRD JSON with PENDING status."""
    return _with_status(
        task_json,
        status_value="PENDING",
        progress=0,
        error_message="",
        completed_at=None,
    )


def mark_task_failed_payload(
    task_json: dict[str, Any] | None, error_message: str
) -> dict[str, Any]:
    """Return task CRD JSON with FAILED status."""
    now = datetime.now().isoformat()
    return _with_status(
        task_json,
        status_value="FAILED",
        progress=100,
        error_message=error_message,
        completed_at=now,
        updated_at=now,
    )


def mark_task_completed_payload(task_json: dict[str, Any] | None) -> dict[str, Any]:
    """Return task CRD JSON with COMPLETED status."""
    now = datetime.now().isoformat()
    return _with_status(
        task_json,
        status_value="COMPLETED",
        progress=100,
        error_message="",
        completed_at=now,
        updated_at=now,
    )


def mark_task_deleted_payload(task_json: dict[str, Any] | None) -> dict[str, Any]:
    """Return task CRD JSON with DELETE status."""
    return _with_status(task_json, status_value="DELETE")


def mark_task_pending(task: Any) -> dict[str, Any]:
    """Reset a task CRD to PENDING before dispatching new work."""
    payload = mark_task_pending_payload(_get_task_json(task))
    _assign_task_json(task, payload)
    return payload


def mark_task_failed(task: Any, error_message: str) -> dict[str, Any]:
    """Persist a terminal prepare/recovery failure on a task CRD."""
    payload = mark_task_failed_payload(_get_task_json(task), error_message)
    _assign_task_json(task, payload)
    return payload


def mark_task_completed(task: Any) -> dict[str, Any]:
    """Mark a task CRD as COMPLETED (e.g. when no AI response is needed)."""
    payload = mark_task_completed_payload(_get_task_json(task))
    _assign_task_json(task, payload)
    return payload


def extract_task_error(task: Any) -> Optional[str]:
    """Return the current task-level error message if present."""
    status = (_get_task_json(task) or {}).get("status", {})
    error_message = status.get("errorMessage")
    if isinstance(error_message, str) and error_message.strip():
        return error_message.strip()
    return None


def _with_status(
    task_json: dict[str, Any] | None,
    *,
    status_value: str,
    progress: Optional[int] = None,
    error_message: Optional[str] = None,
    completed_at: Optional[str] = None,
    updated_at: Optional[str] = None,
) -> dict[str, Any]:
    payload = deepcopy(task_json or {})
    status = payload.setdefault("status", {})
    now = updated_at or datetime.now().isoformat()
    status["status"] = status_value
    if progress is not None:
        status["progress"] = progress
    if error_message is not None:
        status["errorMessage"] = error_message
    status["updatedAt"] = now
    if completed_at is not None or status_value == "PENDING":
        status["completedAt"] = completed_at
    return payload


def _get_task_json(task: Any) -> dict[str, Any] | None:
    if isinstance(task, dict):
        return task
    return getattr(task, "json", None)


def _assign_task_json(task: Any, payload: dict[str, Any]) -> None:
    if isinstance(task, dict):
        task.clear()
        task.update(payload)
        return
    if hasattr(task, "json"):
        task.json = payload
    if hasattr(task, "updated_at"):
        task.updated_at = datetime.now()
