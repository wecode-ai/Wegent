# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task filtering utilities.

This module contains functions for filtering tasks based on various criteria,
including background tasks and subscription tasks.
"""

import logging
from typing import Dict, List

from app.models.task import TaskResource
from app.schemas.kind import Task

logger = logging.getLogger(__name__)


def is_background_task(task_crd: Task) -> bool:
    """
    Check if a task is a background task that should be hidden from user task lists.

    Background tasks include:
    - Summary generation tasks (taskType=summary)
    - Tasks created by background_executor (source=background_executor)
    - Tasks with type=background
    """
    try:
        labels = task_crd.metadata.labels
        if not labels:
            return False

        # Check for background task indicators
        return (
            labels.get("taskType") == "summary"
            or labels.get("source") == "background_executor"
            or labels.get("type") == "background"
        )
    except Exception:
        return False


def is_non_interacted_subscription_task(task_crd: Task) -> bool:
    """
    Check if a task is a Subscription task that the user hasn't interacted with.

    Subscription tasks with userInteracted != 'true' should be filtered out
    from regular task lists.
    """
    try:
        labels = task_crd.metadata.labels or {}
        return (
            labels.get("type") == "subscription"
            and labels.get("userInteracted") != "true"
        )
    except Exception:
        return False


def filter_tasks_for_display(
    tasks: List[TaskResource],
) -> Dict[int, TaskResource]:
    """
    Filter tasks for display in user task lists.

    Filters out:
    - DELETE status tasks
    - Background tasks
    - Non-interacted Subscription tasks

    Args:
        tasks: List of TaskResource objects to filter

    Returns:
        Dict mapping task ID to TaskResource for valid tasks
    """
    id_to_task = {}
    for t in tasks:
        task_crd = Task.model_validate(t.json)
        status = task_crd.status.status if task_crd.status else "PENDING"

        # Filter out DELETE status tasks
        if status == "DELETE":
            continue

        # Filter out background tasks
        if is_background_task(task_crd):
            continue

        # Filter out non-interacted Subscription tasks
        if is_non_interacted_subscription_task(task_crd):
            continue

        id_to_task[t.id] = t

    return id_to_task


def filter_tasks_with_title_match(
    tasks: List[TaskResource],
    title_lower: str,
) -> Dict[int, TaskResource]:
    """
    Filter tasks for display with additional title matching.

    Filters out:
    - DELETE status tasks
    - Tasks that don't match the title search
    - Non-interacted Subscription tasks

    Args:
        tasks: List of TaskResource objects to filter
        title_lower: Lowercase title string to match

    Returns:
        Dict mapping task ID to TaskResource for valid tasks
    """
    id_to_task = {}
    for t in tasks:
        task_crd = Task.model_validate(t.json)
        status = task_crd.status.status if task_crd.status else "PENDING"
        task_title = task_crd.spec.title or ""

        # Filter: not DELETE and title matches
        if status == "DELETE":
            continue
        if title_lower not in task_title.lower():
            continue

        # Filter out non-interacted Subscription tasks
        if is_non_interacted_subscription_task(task_crd):
            continue

        id_to_task[t.id] = t

    return id_to_task


def filter_tasks_since_id(
    tasks: List[TaskResource],
) -> Dict[int, TaskResource]:
    """
    Filter tasks for the get_new_tasks_since_id method.

    Filters out:
    - DELETE status tasks
    - Non-interacted Subscription tasks

    Args:
        tasks: List of TaskResource objects to filter

    Returns:
        Dict mapping task ID to TaskResource for valid tasks
    """
    id_to_task = {}
    for t in tasks:
        task_crd = Task.model_validate(t.json)
        status = task_crd.status.status if task_crd.status else "PENDING"

        if status == "DELETE":
            continue

        # Filter out non-interacted Subscription tasks
        if is_non_interacted_subscription_task(task_crd):
            continue

        id_to_task[t.id] = t

    return id_to_task
