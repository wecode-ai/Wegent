# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared inbox attachment utilities.

Provides helpers for linking inbox message attachments to subtasks so that
prepare_contexts_for_chat() can inject file content into the LLM context window.
Both the subscription mode (subscription_tasks.py) and the direct_agent mode
(direct_agent_handler.py) use these utilities.
"""

import logging

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def link_inbox_attachments_to_subtask(
    db: Session,
    user_subtask_id: int,
    user_id: int,
    inbox_message_id: int,
) -> None:
    """Link inbox message attachments to user_subtask for context injection.

    When a task is triggered by an inbox message, the message's pre-written
    attachments (stored in each USER message's attachmentContextIds field inside
    content_snapshot) must be linked to the user subtask so that
    prepare_contexts_for_chat() can inject the file content into the LLM context
    window.

    This mirrors the chat namespace flow where link_contexts_to_subtask() is
    called after the user sends a message with attachments.

    Args:
        db: Database session
        user_subtask_id: User subtask ID to link attachments to
        user_id: User ID
        inbox_message_id: QueueMessage ID to load attachment IDs from
    """
    from app.services.chat.preprocessing import link_contexts_to_subtask
    from shared.models.db.work_queue import QueueMessage

    # Load the inbox message to get pre-written attachment IDs
    message = db.query(QueueMessage).filter(QueueMessage.id == inbox_message_id).first()

    if not message:
        logger.warning(
            f"[link_inbox_attachments_to_subtask] QueueMessage {inbox_message_id} not found"
        )
        return

    # Collect attachment context IDs from each message's attachmentContextIds field
    attachment_ids: list = []
    for snap in message.content_snapshot or []:
        ids = snap.get("attachmentContextIds") or []
        attachment_ids.extend(ids)

    if not attachment_ids:
        logger.debug(
            f"[link_inbox_attachments_to_subtask] No attachment IDs for message {inbox_message_id}"
        )
        return

    # Link attachments to user subtask so prepare_contexts_for_chat() can inject content
    linked_ids = link_contexts_to_subtask(
        db=db,
        subtask_id=user_subtask_id,
        user_id=user_id,
        attachment_ids=attachment_ids,
        contexts=None,
        task=None,
        user_name=None,
    )
    logger.info(
        f"[link_inbox_attachments_to_subtask] Linked {len(linked_ids)} inbox attachment(s) "
        f"(message_id={inbox_message_id}) to user_subtask {user_subtask_id}"
    )
