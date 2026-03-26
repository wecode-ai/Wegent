# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message Forwarding Service for forwarding messages to work queues."""

import asyncio
import logging
from datetime import datetime
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

        # Determine content based on role:
        # - USER messages: content is in subtask.prompt
        # - AI messages: content is in subtask.result.value
        role = subtask.role.value if subtask.role else "USER"
        if role == "USER":
            # User messages have content in prompt field
            content = subtask.prompt or ""
        else:
            # AI messages have content in result.value
            content = ""
            if subtask.result:
                content = subtask.result.get("value", "")
            # Fallback to prompt if result is empty (shouldn't happen for AI)
            if not content and subtask.prompt:
                content = subtask.prompt

        return MessageContentSnapshot(
            role=role,
            content=content,
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

        # Get sender user for notification
        sender_user = db.query(User).filter(User.id == sender_user_id).first()
        if not sender_user:
            raise NotFoundException(f"Sender user {sender_user_id} not found")

        # Get or create the target queue
        if queue_id:
            queue = work_queue_service.get_queue_by_id(queue_id)
            if not queue or queue.user_id != target_user_id:
                raise NotFoundException("Target queue not found")
        else:
            # Try to find a public queue that the sender can access
            queue = work_queue_service.get_user_public_default_queue(target_user_id)
            if not queue:
                # Create default public queue for user
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
        db_message = queue_message_service.create_message(message_data)

        logger.info(
            f"Forwarded messages to user: sender={sender_user_id}, "
            f"recipient={target_user_id}, queue={queue.id}"
        )

        # Send WebSocket notification to recipient
        self._notify_message_received(
            recipient_user_id=target_user_id,
            message_id=db_message.id,
            queue_id=queue.id,
            queue_name=queue.name,
            sender_id=sender_user_id,
            sender_name=sender_user.user_name,
            content_snapshots=content_snapshots,
            priority=priority,
            created_at=db_message.created_at,
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

    def _notify_message_received(
        self,
        recipient_user_id: int,
        message_id: int,
        queue_id: int,
        queue_name: str,
        sender_id: int,
        sender_name: str,
        content_snapshots: List[MessageContentSnapshot],
        priority: QueueMessagePriority,
        created_at: datetime,
    ) -> None:
        """Send WebSocket notification to recipient about new queue message.

        Args:
            recipient_user_id: Target user ID
            message_id: Queue message ID
            queue_id: Work queue ID
            queue_name: Work queue name
            sender_id: Sender user ID
            sender_name: Sender username
            content_snapshots: Message content snapshots
            priority: Message priority
            created_at: Message creation time
        """
        try:
            from app.services.chat.webpage_ws_chat_emitter import (
                get_main_event_loop,
                get_webpage_ws_emitter,
            )

            ws_emitter = get_webpage_ws_emitter()
            if not ws_emitter:
                logger.warning(
                    "[MessageForwarding] WebSocket emitter not initialized, skipping notification"
                )
                return

            # Generate preview from content snapshots
            preview = ""
            if content_snapshots:
                # Get the last user message for preview
                for snapshot in reversed(content_snapshots):
                    if snapshot.role == "USER" and snapshot.content:
                        preview = snapshot.content[:200]
                        break
                # Fallback to first message if no user message found
                if not preview and content_snapshots[0].content:
                    preview = content_snapshots[0].content[:200]

            # Get the main event loop for async emit
            main_loop = get_main_event_loop()
            if main_loop and main_loop.is_running():
                # Schedule the emit in the main event loop
                asyncio.run_coroutine_threadsafe(
                    ws_emitter.emit_queue_message_received(
                        user_id=recipient_user_id,
                        message_id=message_id,
                        queue_id=queue_id,
                        queue_name=queue_name,
                        sender_id=sender_id,
                        sender_name=sender_name,
                        preview=preview,
                        priority=priority.value,
                        created_at=created_at.isoformat(),
                    ),
                    main_loop,
                )
                logger.debug(
                    f"[MessageForwarding] Scheduled WebSocket notification for user {recipient_user_id}"
                )
            else:
                logger.warning(
                    "[MessageForwarding] Main event loop not available, skipping WebSocket notification"
                )

        except Exception as e:
            # Don't fail the message forwarding if notification fails
            logger.error(
                f"[MessageForwarding] Failed to send WebSocket notification: {e}"
            )


# Global service instance
message_forwarding_service = MessageForwardingService()
