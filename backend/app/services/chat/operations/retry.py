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

from sqlalchemy import and_
from sqlalchemy.orm import Session, aliased, joinedload

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource

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
    TaskKind = aliased(TaskResource)
    TeamKind = aliased(Kind)

    # Optimized query: fetch failed_ai_subtask, task, and team in one go
    query_result = (
        db.query(
            Subtask,  # failed_ai_subtask
            TaskKind,  # task
            TeamKind,  # team
        )
        .select_from(Subtask)  # Explicitly specify the main table
        .outerjoin(
            TaskKind,
            and_(
                TaskKind.id == task_id,
                TaskKind.kind == "Task",
                TaskKind.is_active,
            ),
        )
        .outerjoin(
            TeamKind,
            and_(
                TeamKind.id == Subtask.team_id,
                TeamKind.kind == "Team",
                TeamKind.is_active,
            ),
        )
        .filter(
            Subtask.id == subtask_id,
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
        )
        .first()
    )

    if not query_result:
        return None, None, None, None

    failed_ai_subtask, task, team = query_result

    # Fetch user subtask separately
    # Key insight: parent_id stores message_id (not subtask.id) throughout the system
    # Both in chat.py and task_kinds.py, parent_id is always set to message_id
    user_subtask = None
    if failed_ai_subtask and failed_ai_subtask.parent_id:
        # Use parent_id as message_id to find the triggering USER subtask
        # This works for both single chat and group chat
        user_subtask = (
            db.query(Subtask)
            .options(joinedload(Subtask.attachments))  # Preload attachments
            .filter(
                Subtask.task_id == failed_ai_subtask.task_id,
                Subtask.message_id == failed_ai_subtask.parent_id,
                Subtask.role == SubtaskRole.USER,
            )
            .first()
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


def reset_subtask_for_retry(db: Session, subtask: Subtask) -> None:
    """
    Reset a failed subtask to PENDING status for retry.

    Args:
        db: Database session
        subtask: The subtask to reset

    Raises:
        Exception: If database commit fails
    """
    subtask.status = SubtaskStatus.PENDING
    subtask.progress = 0
    subtask.error_message = ""
    subtask.result = None
    subtask.updated_at = datetime.now()

    try:
        db.commit()
        db.refresh(subtask)
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
