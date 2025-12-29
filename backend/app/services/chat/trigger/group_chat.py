# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Group chat utilities for Chat Shell.

This module provides utilities for group chat functionality including:
- AI response trigger determination based on @mentions
- Group member notification via WebSocket
"""

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.schemas.kind import Task

logger = logging.getLogger(__name__)


def should_trigger_ai_response(
    task_json: dict, prompt: str, team_name: str, request_is_group_chat: bool = False
) -> bool:
    """
    Determine whether to trigger AI response based on task mode and prompt content.

    For non-group-chat mode: always trigger AI
    For group-chat mode: only trigger if prompt contains @TeamName (exact match)

    Args:
        task_json: Task's JSON spec
        prompt: User's input message
        team_name: Associated Team name
        request_is_group_chat: Whether the request explicitly marks this as a group chat
                              (used for new tasks where task_json is empty)

    Returns:
        True if AI response should be triggered, False if only save message
    """
    # Check if task is in group chat mode
    # For existing tasks: check task_json.spec.is_group_chat
    # For new tasks: use request_is_group_chat parameter
    is_group_chat = task_json.get("spec", {}).get("is_group_chat", False)

    # If task_json doesn't have is_group_chat set, use the request parameter
    # This handles the case of creating a new group chat task
    if not is_group_chat and request_is_group_chat:
        is_group_chat = True

    # Non-group-chat mode: always trigger AI
    if not is_group_chat:
        return True

    # Group chat mode: check for @TeamName mention (exact match)
    mention_pattern = f"@{team_name}"
    return mention_pattern in prompt


async def notify_group_members_task_updated(
    db: Session, task: TaskResource, sender_user_id: int
) -> None:
    """
    Notify all group chat members about task update via WebSocket.

    This sends a task:status event to each member's user room so their
    task list can show the unread indicator for new messages.

    Args:
        db: Database session
        task: Task Kind object
        sender_user_id: User ID of the message sender (to exclude from notification)
    """
    from app.models.task_member import MemberStatus, TaskMember
    from app.services.chat.ws_emitter import get_ws_emitter

    ws_emitter = get_ws_emitter()
    if not ws_emitter:
        logger.warning(
            f"[notify_group_members_task_updated] WebSocket emitter not available"
        )
        return

    try:
        # Get all active members of this group chat
        members = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task.id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .all()
        )

        # Also include the task owner
        member_user_ids = {m.user_id for m in members}
        member_user_ids.add(task.user_id)

        # Get current task status
        task_crd = Task.model_validate(task.json)
        current_status = task_crd.status.status if task_crd.status else "PENDING"

        # Notify each member (except the sender) about the task update
        for member_user_id in member_user_ids:
            if member_user_id == sender_user_id:
                # Skip the sender - they already know about their own message
                continue

            await ws_emitter.emit_task_status(
                user_id=member_user_id,
                task_id=task.id,
                status=current_status,
                progress=task_crd.status.progress if task_crd.status else 0,
            )
            logger.debug(
                f"[notify_group_members_task_updated] Notified user {member_user_id} about task {task.id} update"
            )

    except Exception as e:
        logger.warning(
            f"[notify_group_members_task_updated] Failed to notify group members: {e}"
        )


def is_task_group_chat(task: TaskResource, request_is_group_chat: bool = False) -> bool:
    """
    Check if a task is a group chat.

    Args:
        task: Task resource object
        request_is_group_chat: Request-level group chat flag (for new tasks)

    Returns:
        True if the task is a group chat
    """
    if request_is_group_chat:
        return True
    return task.json.get("spec", {}).get("is_group_chat", False)
