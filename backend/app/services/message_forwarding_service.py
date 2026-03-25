# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message Forwarding Service for forwarding messages to work queues."""

import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import ForbiddenException, NotFoundException
from app.db.session import SessionLocal
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.subtask import SubtaskContextBrief
from app.schemas.work_queue import (
    ForwardMessageRequest,
    ForwardMessageResponse,
    ForwardRecipient,
    MessageContentSnapshot,
    QueueMessageCreate,
    QueueMessagePriority,
)
from app.services.work_queue_service import (
    contact_service,
    queue_message_service,
    work_queue_service,
)

logger = logging.getLogger(__name__)


class MessageForwardingService:
    """Service for forwarding messages to work queues."""

    def get_db(self) -> Session:
        """Get database session."""
        return SessionLocal()

    def _get_message_content_snapshot(self, subtask: Subtask) -> MessageContentSnapshot:
        """Create a content snapshot from a subtask."""
        # Build attachment info
        attachments = []
        if subtask.contexts:
            for ctx in subtask.contexts:
                brief = SubtaskContextBrief.from_model(ctx)
                attachments.append(brief.model_dump())

        return MessageContentSnapshot(
            role=subtask.role.value if subtask.role else "USER",
            content=(
                subtask.prompt or subtask.result.get("value", "")
                if subtask.result
                else ""
            ),
            senderUserName=getattr(subtask, "sender_user_name", None),
            createdAt=subtask.created_at.isoformat() if subtask.created_at else None,
            attachments=attachments if attachments else None,
        )

    def forward_messages(
        self,
        sender_user_id: int,
        request: ForwardMessageRequest,
    ) -> ForwardMessageResponse:
        """Forward messages to one or more recipients."""
        with self.get_db() as db:
            # Get the source task
            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == request.sourceTaskId,
                    TaskResource.is_active == TaskResource.STATE_ACTIVE,
                )
                .first()
            )
            if not task:
                raise NotFoundException("Source task not found")

            # Get subtasks (messages) to forward
            if request.subtaskIds:
                subtasks = (
                    db.query(Subtask)
                    .filter(
                        Subtask.task_id == request.sourceTaskId,
                        Subtask.id.in_(request.subtaskIds),
                    )
                    .order_by(Subtask.message_id.asc())
                    .all()
                )
            else:
                # Forward entire conversation
                subtasks = (
                    db.query(Subtask)
                    .filter(Subtask.task_id == request.sourceTaskId)
                    .order_by(Subtask.message_id.asc())
                    .all()
                )

            if not subtasks:
                raise NotFoundException("No messages to forward")

            # Create content snapshots
            content_snapshots = [
                self._get_message_content_snapshot(s) for s in subtasks
            ]
            subtask_ids = [s.id for s in subtasks]

            # Forward to each recipient
            forwarded_count = 0
            failed_recipients = []

            for recipient in request.recipients:
                try:
                    self._forward_to_recipient(
                        db=db,
                        sender_user_id=sender_user_id,
                        recipient=recipient,
                        source_task_id=request.sourceTaskId,
                        subtask_ids=subtask_ids,
                        content_snapshots=content_snapshots,
                        note=request.note,
                        priority=request.priority,
                    )
                    forwarded_count += 1

                    # Record contact
                    if recipient.type == "user":
                        contact_service.record_contact(sender_user_id, recipient.id)

                except Exception as e:
                    logger.error(
                        f"Failed to forward to recipient: {recipient}, error: {e}"
                    )
                    failed_recipients.append(
                        {
                            "type": recipient.type,
                            "id": recipient.id,
                            "error": str(e),
                        }
                    )

            return ForwardMessageResponse(
                success=forwarded_count > 0,
                forwardedCount=forwarded_count,
                failedRecipients=failed_recipients if failed_recipients else None,
            )

    def _forward_to_recipient(
        self,
        db: Session,
        sender_user_id: int,
        recipient: ForwardRecipient,
        source_task_id: int,
        subtask_ids: List[int],
        content_snapshots: List[MessageContentSnapshot],
        note: Optional[str],
        priority: QueueMessagePriority,
    ) -> None:
        """Forward messages to a single recipient."""
        if recipient.type == "user":
            self._forward_to_user(
                db=db,
                sender_user_id=sender_user_id,
                target_user_id=recipient.id,
                queue_id=recipient.queueId,
                source_task_id=source_task_id,
                subtask_ids=subtask_ids,
                content_snapshots=content_snapshots,
                note=note,
                priority=priority,
            )
        elif recipient.type == "group":
            self._forward_to_group(
                db=db,
                sender_user_id=sender_user_id,
                group_namespace=str(recipient.id),
                source_task_id=source_task_id,
                subtask_ids=subtask_ids,
                content_snapshots=content_snapshots,
                note=note,
                priority=priority,
            )
        else:
            raise ValueError(f"Unknown recipient type: {recipient.type}")

    def _forward_to_user(
        self,
        db: Session,
        sender_user_id: int,
        target_user_id: int,
        queue_id: Optional[int],
        source_task_id: int,
        subtask_ids: List[int],
        content_snapshots: List[MessageContentSnapshot],
        note: Optional[str],
        priority: QueueMessagePriority,
    ) -> None:
        """Forward messages to a user's queue."""
        # Get target user
        target_user = db.query(User).filter(User.id == target_user_id).first()
        if not target_user:
            raise NotFoundException(f"User {target_user_id} not found")

        # Get or create the target queue
        if queue_id:
            queue = work_queue_service.get_queue_by_id(queue_id)
            if not queue or queue.user_id != target_user_id:
                raise NotFoundException("Target queue not found")
        else:
            # Use default queue
            queue = work_queue_service.get_user_default_queue(target_user_id)
            if not queue:
                # Create default queue for user
                queue = work_queue_service.ensure_default_queue(target_user_id)

        # Check if sender can send to this queue
        if not work_queue_service.can_send_to_queue(sender_user_id, queue):
            raise ForbiddenException("You don't have permission to send to this queue")

        # Create the queue message
        message_data = QueueMessageCreate(
            queue_id=queue.id,
            sender_user_id=sender_user_id,
            recipient_user_id=target_user_id,
            source_task_id=source_task_id,
            source_subtask_ids=subtask_ids,
            content_snapshot=content_snapshots,
            note=note,
            priority=priority,
        )
        queue_message_service.create_message(message_data)

        logger.info(
            f"Forwarded messages to user: sender={sender_user_id}, "
            f"recipient={target_user_id}, queue={queue.id}"
        )

    def _forward_to_group(
        self,
        db: Session,
        sender_user_id: int,
        group_namespace: str,
        source_task_id: int,
        subtask_ids: List[int],
        content_snapshots: List[MessageContentSnapshot],
        note: Optional[str],
        priority: QueueMessagePriority,
    ) -> None:
        """Forward messages to all members of a group."""
        from app.models.namespace_member import NamespaceMember

        # Get all group members
        members = (
            db.query(NamespaceMember)
            .filter(
                NamespaceMember.group_name == group_namespace,
                NamespaceMember.is_active.is_(True),
            )
            .all()
        )

        if not members:
            raise NotFoundException(f"Group {group_namespace} has no members")

        # Forward to each member (except sender)
        for member in members:
            if member.user_id == sender_user_id:
                continue

            try:
                self._forward_to_user(
                    db=db,
                    sender_user_id=sender_user_id,
                    target_user_id=member.user_id,
                    queue_id=None,  # Use default queue
                    source_task_id=source_task_id,
                    subtask_ids=subtask_ids,
                    content_snapshots=content_snapshots,
                    note=note,
                    priority=priority,
                )
            except Exception as e:
                logger.error(f"Failed to forward to group member {member.user_id}: {e}")


# Global service instance
message_forwarding_service = MessageForwardingService()
