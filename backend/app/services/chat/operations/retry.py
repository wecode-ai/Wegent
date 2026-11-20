# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Retry operation utilities for Chat Service.

This module provides utilities for retrying failed chat messages,
including context fetching and subtask reset.
"""

import logging
from datetime import datetime
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.services.task_status import mark_task_pending_payload
from app.stores.tasks import subtask_store, task_store

logger = logging.getLogger(__name__)


def fetch_retry_context(
    db: Session,
    task_id: int,
    subtask_id: int,
) -> Tuple[
    Optional[Subtask],
    Optional[TaskResource],
    Optional[Kind],
    Optional[Subtask],
]:
    """
    Fetch all required database entities for retry operation in a single optimized query.

    Args:
        db: Database session
        task_id: Task ID
        subtask_id: Subtask ID to retry

    Returns:
        Tuple of (failed_ai_subtask, task, team, user_subtask)
    """
    failed_ai_subtask = subtask_store.get_retry_assistant(
        db,
        task_id=task_id,
        subtask_id=subtask_id,
    )
    if not failed_ai_subtask:
        return None, None, None, None

    task = task_store.get_non_deleted_task(db, task_id=task_id)
    team = (
        db.query(Kind)
        .filter(
            Kind.id == failed_ai_subtask.team_id,
            Kind.kind == "Team",
            Kind.is_active,
        )
        .first()
    )

    # Fetch user subtask separately
    # Key insight: parent_id stores message_id (not subtask.id) throughout the system
    # Both in chat.py and task_kinds.py, parent_id is always set to message_id
    user_subtask = None
    if failed_ai_subtask and failed_ai_subtask.parent_id:
        # Use parent_id as message_id to find the triggering USER subtask
        # This works for both single chat and group chat
        user_subtask = subtask_store.get_user_by_task_message_id(
            db,
            task_id=failed_ai_subtask.task_id,
            message_id=failed_ai_subtask.parent_id,
        )
        if user_subtask:
            logger.info(
                f"Found user_subtask via parent_id as message_id: "
                f"id={user_subtask.id}, message_id={user_subtask.message_id}, "
                f"prompt={user_subtask.prompt[:50] if user_subtask.prompt else ''}..."
            )
        else:
            logger.warning(
                f"Could not find USER subtask with message_id={failed_ai_subtask.parent_id}"
            )

    return failed_ai_subtask, task, team, user_subtask


def reset_subtask_for_retry(
    db: Session, subtask: Subtask, task: Optional[TaskResource] = None
) -> None:
    """
    Reset a failed subtask to PENDING status for retry.

    Also updates the Task status to PENDING so that executor_manager can pick it up.
    This is critical because executor_manager queries tasks based on Task.json.status.status.

    Args:
        db: Database session
        subtask: The subtask to reset
        task: The task to update (optional, but recommended for non-direct-chat retries)

    Raises:
        Exception: If database commit fails
    """
    subtask_store.update_fields(
        db,
        subtask=subtask,
        status=SubtaskStatus.PENDING,
        progress=0,
        error_message="",
        result=None,
        updated_at=datetime.now(),
    )

    # Also reset Task status to PENDING so executor_manager can fetch it
    # This is critical: executor_manager queries by Task.json.status.status = PENDING
    if task:
        task_store.update_json(
            db,
            task=task,
            payload=mark_task_pending_payload(task.json),
        )
        logger.info(f"Reset task status to PENDING: task_id={task.id}")

    try:
        db.commit()
        db.refresh(subtask)
        if task:
            db.refresh(task)
    except Exception as e:
        logger.error(f"Failed to reset subtask: {e}", exc_info=True)
        db.rollback()
        raise  # Re-raise to prevent downstream processing

    logger.info(
        f"Reset subtask to PENDING: id={subtask.id}, message_id={subtask.message_id}"
    )


def extract_model_override_info(task: TaskResource) -> Tuple[Optional[str], bool]:
    """
    Extract model override information from task metadata.

    Reading Model Override Metadata:
    - Primary source: task.json.metadata.labels (set by on_chat_send when user overrides model)
    - Fallback source: task.json.spec (for compatibility with other shells)

    Args:
        task: The task containing metadata

    Returns:
        Tuple of (model_id, force_override)
    """
    task_spec_dict = task.json.get("spec", {})
    task_metadata = task.json.get("metadata", {})
    task_labels = task_metadata.get("labels", {})

    # Try to get model info from metadata.labels first (for direct chat)
    model_id = task_labels.get("modelId") or task_spec_dict.get("modelId")
    force_override = (
        task_labels.get("forceOverrideBotModel") == "true"
        or task_spec_dict.get("forceOverrideBotModel") == "true"
    )

    logger.info(
        f"Extracted model info: model_id={model_id}, force_override={force_override}"
    )

    return model_id, force_override
