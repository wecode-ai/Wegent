# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for reading Task execution workspace metadata."""

from typing import Any, Optional

from app.models.task import TaskResource


def task_execution_workspace(task: TaskResource) -> dict[str, Any]:
    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.get("spec") if isinstance(task_json.get("spec"), dict) else {}
    execution = spec.get("execution") if isinstance(spec.get("execution"), dict) else {}
    workspace = (
        execution.get("workspace")
        if isinstance(execution.get("workspace"), dict)
        else {}
    )
    return workspace


def task_execution_workspace_path(task: TaskResource) -> Optional[str]:
    path = task_execution_workspace(task).get("path")
    if not isinstance(path, str):
        return None
    return path.strip() or None


def task_execution_workspace_source(task: TaskResource) -> Optional[str]:
    source = task_execution_workspace(task).get("source")
    if not isinstance(source, str):
        return None
    return source.strip() or None
