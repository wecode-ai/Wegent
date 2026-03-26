# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Work Queue Service for managing work queues and queue messages."""

import logging
import secrets
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
)
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.models.work_queue import (
    QueueMessage,
    QueueMessagePriority,
    QueueMessageStatus,
    QueueVisibility,
    RecentContact,
)
from app.schemas.work_queue import (
    AutoProcessConfig,
    ForwardRecipient,
    MessageContentSnapshot,
    QueueMessageCreate,
    QueueMessageResponse,
    ResultFeedbackConfig,
    SenderInfo,
    WorkQueueCreate,
    WorkQueueResponse,
    WorkQueueUpdate,
)
from app.services.group_permission import check_user_group_permission

logger = logging.getLogger(__name__)


class WorkQueueService:
    """Service for managing work queues."""

    WORK_QUEUE_KIND = "WorkQueue"

    def get_db(self) -> Session:
        """Get database session."""
        return SessionLocal()

    def _generate_invite_code(self) -> str:
        """Generate a random invite code."""
        return secrets.token_urlsafe(16)

    def _build_queue_response(
        self,
        db_queue: Kind,
        message_counts: Optional[Dict[int, Tuple[int, int]]] = None,
    ) -> WorkQueueResponse:
        """Build WorkQueueResponse from Kind model."""
        spec = db_queue.json.get("spec", {})
        status = db_queue.json.get("status", {})

        # Get message counts if not provided
        if message_counts is None:
            total, unread = self._get_queue_message_counts(db_queue.id)
        else:
            total, unread = message_counts.get(db_queue.id, (0, 0))

        # Parse autoProcess config
        auto_process_data = spec.get("autoProcess")
        auto_process = None
        if auto_process_data:
            auto_process = AutoProcessConfig(**auto_process_data)

        # Parse resultFeedback config
        result_feedback_data = spec.get("resultFeedback")
        result_feedback = None
        if result_feedback_data:
            result_feedback = ResultFeedbackConfig(**result_feedback_data)

        return WorkQueueResponse(
            id=db_queue.id,
            name=db_queue.name,
            displayName=spec.get("displayName", db_queue.name),
            description=spec.get("description"),
            isDefault=spec.get("isDefault", False),
            visibility=QueueVisibility(spec.get("visibility", "private")),
            visibleToGroups=spec.get("visibleToGroups"),
            inviteCode=spec.get("inviteCode"),
            autoProcess=auto_process,
            resultFeedback=result_feedback,
            messageCount=total,
            unreadCount=unread,
            createdAt=db_queue.created_at,
            updatedAt=db_queue.updated_at,
        )

    def _get_queue_message_counts(self, queue_id: int) -> Tuple[int, int]:
        """Get total and unread message counts for a queue."""
        with self.get_db() as db:
            total = (
                db.query(func.count(QueueMessage.id))
                .filter(
                    QueueMessage.queue_id == queue_id,
                    QueueMessage.status != QueueMessageStatus.ARCHIVED,
                )
                .scalar()
                or 0
            )
            unread = (
                db.query(func.count(QueueMessage.id))
                .filter(
                    QueueMessage.queue_id == queue_id,
                    QueueMessage.status == QueueMessageStatus.UNREAD,
                )
                .scalar()
                or 0
            )
            return total, unread

    def _get_batch_message_counts(
        self, queue_ids: List[int]
    ) -> Dict[int, Tuple[int, int]]:
        """Get message counts for multiple queues in batch."""
        if not queue_ids:
            return {}

        with self.get_db() as db:
            # Get total counts
            total_counts = (
                db.query(QueueMessage.queue_id, func.count(QueueMessage.id))
                .filter(
                    QueueMessage.queue_id.in_(queue_ids),
                    QueueMessage.status != QueueMessageStatus.ARCHIVED,
                )
                .group_by(QueueMessage.queue_id)
                .all()
            )

            # Get unread counts
            unread_counts = (
                db.query(QueueMessage.queue_id, func.count(QueueMessage.id))
                .filter(
                    QueueMessage.queue_id.in_(queue_ids),
                    QueueMessage.status == QueueMessageStatus.UNREAD,
                )
                .group_by(QueueMessage.queue_id)
                .all()
            )

            total_map = {qid: count for qid, count in total_counts}
            unread_map = {qid: count for qid, count in unread_counts}

            return {
                qid: (total_map.get(qid, 0), unread_map.get(qid, 0))
                for qid in queue_ids
            }

    def list_queues(self, user_id: int) -> List[WorkQueueResponse]:
        """List all work queues for a user."""
        with self.get_db() as db:
            queues = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .order_by(Kind.created_at.desc())
                .all()
            )

            # Get message counts in batch
            queue_ids = [q.id for q in queues]
            message_counts = self._get_batch_message_counts(queue_ids)

            return [self._build_queue_response(q, message_counts) for q in queues]

    def get_queue(self, user_id: int, queue_id: int) -> Optional[WorkQueueResponse]:
        """Get a specific work queue."""
        with self.get_db() as db:
            queue = (
                db.query(Kind)
                .filter(
                    Kind.id == queue_id,
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.is_active == True,
                )
                .first()
            )
            if not queue:
                return None
            return self._build_queue_response(queue)

    def get_queue_by_id(self, queue_id: int) -> Optional[Kind]:
        """Get a queue Kind by ID (internal use)."""
        with self.get_db() as db:
            return (
                db.query(Kind)
                .filter(
                    Kind.id == queue_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.is_active == True,
                )
                .first()
            )

    def create_queue(self, user_id: int, data: WorkQueueCreate) -> WorkQueueResponse:
        """Create a new work queue."""
        with self.get_db() as db:
            # Check if queue with same name already exists
            existing = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.namespace == "default",
                    Kind.name == data.name,
                    Kind.is_active == True,
                )
                .first()
            )
            if existing:
                raise ConflictException(f"Work queue '{data.name}' already exists")

            # Generate invite code if visibility is invite_only
            invite_code = None
            if data.visibility == QueueVisibility.INVITE_ONLY:
                invite_code = self._generate_invite_code()

            # Build spec
            spec = {
                "displayName": data.displayName,
                "description": data.description,
                "isDefault": False,
                "visibility": data.visibility.value,
                "visibleToGroups": data.visibleToGroups,
                "inviteCode": invite_code,
            }

            if data.autoProcess:
                spec["autoProcess"] = data.autoProcess.model_dump()
            if data.resultFeedback:
                spec["resultFeedback"] = data.resultFeedback.model_dump()

            # Build resource JSON
            resource_json = {
                "apiVersion": "agent.wecode.io/v1",
                "kind": self.WORK_QUEUE_KIND,
                "metadata": {
                    "name": data.name,
                    "namespace": "default",
                },
                "spec": spec,
                "status": {"state": "Available"},
            }

            # Create Kind record
            db_queue = Kind(
                user_id=user_id,
                kind=self.WORK_QUEUE_KIND,
                name=data.name,
                namespace="default",
                json=resource_json,
            )
            db.add(db_queue)
            db.commit()
            db.refresh(db_queue)

            logger.info(
                f"Created work queue: id={db_queue.id}, name={data.name}, user_id={user_id}"
            )

            return self._build_queue_response(db_queue)

    def update_queue(
        self, user_id: int, queue_id: int, data: WorkQueueUpdate
    ) -> WorkQueueResponse:
        """Update a work queue."""
        with self.get_db() as db:
            queue = (
                db.query(Kind)
                .filter(
                    Kind.id == queue_id,
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.is_active == True,
                )
                .first()
            )
            if not queue:
                raise NotFoundException(f"Work queue not found")

            # Update spec
            spec = queue.json.get("spec", {})

            if data.displayName is not None:
                spec["displayName"] = data.displayName
            if data.description is not None:
                spec["description"] = data.description
            if data.visibility is not None:
                spec["visibility"] = data.visibility.value
                # Generate new invite code if switching to invite_only
                if data.visibility == QueueVisibility.INVITE_ONLY and not spec.get(
                    "inviteCode"
                ):
                    spec["inviteCode"] = self._generate_invite_code()
            if data.visibleToGroups is not None:
                spec["visibleToGroups"] = data.visibleToGroups
            if data.autoProcess is not None:
                spec["autoProcess"] = data.autoProcess.model_dump()
            if data.resultFeedback is not None:
                spec["resultFeedback"] = data.resultFeedback.model_dump()

            queue.json["spec"] = spec
            queue.updated_at = datetime.now()
            db.commit()
            db.refresh(queue)

            logger.info(f"Updated work queue: id={queue_id}, user_id={user_id}")

            return self._build_queue_response(queue)

    def delete_queue(self, user_id: int, queue_id: int) -> bool:
        """Soft delete a work queue."""
        with self.get_db() as db:
            queue = (
                db.query(Kind)
                .filter(
                    Kind.id == queue_id,
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.is_active == True,
                )
                .first()
            )
            if not queue:
                raise NotFoundException(f"Work queue not found")

            queue.is_active = False
            queue.updated_at = datetime.now()
            db.commit()

            logger.info(f"Deleted work queue: id={queue_id}, user_id={user_id}")

            return True

    def set_default_queue(self, user_id: int, queue_id: int) -> WorkQueueResponse:
        """Set a queue as the default queue."""
        with self.get_db() as db:
            # First, unset all other default queues (Python-level update for PostgreSQL compatibility)
            queues = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.is_active.is_(True),
                )
                .all()
            )
            for q in queues:
                if q.json.get("spec", {}).get("isDefault"):
                    q.json = {
                        **q.json,
                        "spec": {**q.json.get("spec", {}), "isDefault": False},
                    }
                    q.updated_at = datetime.now()

            # Set the specified queue as default
            queue = (
                db.query(Kind)
                .filter(
                    Kind.id == queue_id,
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.is_active.is_(True),
                )
                .first()
            )
            if not queue:
                raise NotFoundException(f"Work queue not found")

            spec = queue.json.get("spec", {})
            spec["isDefault"] = True
            queue.json["spec"] = spec
            queue.updated_at = datetime.now()
            db.commit()
            db.refresh(queue)

            logger.info(f"Set default work queue: id={queue_id}, user_id={user_id}")

            return self._build_queue_response(queue)

    def regenerate_invite_code(self, user_id: int, queue_id: int) -> WorkQueueResponse:
        """Regenerate the invite code for a queue."""
        with self.get_db() as db:
            queue = (
                db.query(Kind)
                .filter(
                    Kind.id == queue_id,
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.is_active == True,
                )
                .first()
            )
            if not queue:
                raise NotFoundException(f"Work queue not found")

            spec = queue.json.get("spec", {})
            if spec.get("visibility") != QueueVisibility.INVITE_ONLY.value:
                raise ConflictException(
                    "Cannot regenerate invite code for non-invite-only queue"
                )

            spec["inviteCode"] = self._generate_invite_code()
            queue.json["spec"] = spec
            queue.updated_at = datetime.now()
            db.commit()
            db.refresh(queue)

            logger.info(
                f"Regenerated invite code for queue: id={queue_id}, user_id={user_id}"
            )

            return self._build_queue_response(queue)

    def get_user_default_queue(self, user_id: int) -> Optional[Kind]:
        """Get user's default queue."""
        with self.get_db() as db:
            # Try to find explicit default
            queues = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .all()
            )

            for q in queues:
                if q.json.get("spec", {}).get("isDefault"):
                    return q

            # Return the first queue if no default is set
            return queues[0] if queues else None

    def get_user_public_default_queue(self, user_id: int) -> Optional[Kind]:
        """Get user's default public queue that others can send to.

        This method prioritizes:
        1. A public queue marked as default
        2. Any public queue
        3. None (caller should create a default public queue)
        """
        with self.get_db() as db:
            queues = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .all()
            )

            # First, try to find a public queue marked as default
            for q in queues:
                spec = q.json.get("spec", {})
                if (
                    spec.get("isDefault")
                    and spec.get("visibility") == QueueVisibility.PUBLIC.value
                ):
                    return q

            # Then, try to find any public queue
            for q in queues:
                spec = q.json.get("spec", {})
                if spec.get("visibility") == QueueVisibility.PUBLIC.value:
                    return q

            # No public queue found
            return None

    def get_user_public_queues(self, target_user_id: int) -> List[Dict[str, Any]]:
        """Get public queues of a user (for message forwarding)."""
        with self.get_db() as db:
            queues = (
                db.query(Kind)
                .filter(
                    Kind.user_id == target_user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .all()
            )

            result = []
            for q in queues:
                spec = q.json.get("spec", {})
                visibility = spec.get("visibility", "private")
                if visibility in ["public", "invite_only"]:
                    result.append(
                        {
                            "id": q.id,
                            "name": q.name,
                            "displayName": spec.get("displayName", q.name),
                            "description": spec.get("description"),
                            "isDefault": spec.get("isDefault", False),
                        }
                    )

            return result

    def can_send_to_queue(
        self,
        sender_user_id: int,
        queue: Kind,
        invite_code: Optional[str] = None,
    ) -> bool:
        """Check if a user can send messages to a queue."""
        spec = queue.json.get("spec", {})
        visibility = spec.get("visibility", "private")

        if visibility == QueueVisibility.PRIVATE.value:
            # Only owner can send to private queue
            return queue.user_id == sender_user_id

        if visibility == QueueVisibility.PUBLIC.value:
            return True

        if visibility == QueueVisibility.GROUP_VISIBLE.value:
            # Check if sender is member of any visible groups
            visible_groups = spec.get("visibleToGroups", [])
            for group_namespace in visible_groups:
                if check_user_group_permission(
                    sender_user_id, group_namespace, "Reporter"
                ):
                    return True
            return False

        if visibility == QueueVisibility.INVITE_ONLY.value:
            # Check invite code
            return invite_code == spec.get("inviteCode")

        return False

    def ensure_default_queue(self, user_id: int) -> Kind:
        """Ensure user has a public queue that others can send to.

        If user has no public queue, creates a new one named 'inbox'.
        If 'inbox' already exists but is not public, updates it to be public.
        """
        # First check if user already has a public queue
        public_queue = self.get_user_public_default_queue(user_id)
        if public_queue:
            return public_queue

        with self.get_db() as db:
            # Check if 'inbox' already exists (might be private)
            existing_inbox = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == self.WORK_QUEUE_KIND,
                    Kind.namespace == "default",
                    Kind.name == "inbox",
                    Kind.is_active == True,
                )
                .first()
            )

            if existing_inbox:
                # Update existing inbox to be public
                spec = existing_inbox.json.get("spec", {})
                spec["visibility"] = QueueVisibility.PUBLIC.value
                existing_inbox.json["spec"] = spec
                existing_inbox.updated_at = datetime.now()
                db.commit()
                db.refresh(existing_inbox)
                logger.info(
                    f"Updated existing inbox to public: id={existing_inbox.id}, user_id={user_id}"
                )
                return existing_inbox

        # Create new public inbox
        inbox_data = WorkQueueCreate(
            name="inbox",
            displayName="Inbox",
            description="Default public inbox for receiving messages",
            visibility=QueueVisibility.PUBLIC,
        )
        response = self.create_queue(user_id, inbox_data)

        # Set as default
        self.set_default_queue(user_id, response.id)

        logger.info(f"Created public inbox: id={response.id}, user_id={user_id}")
        return self.get_queue_by_id(response.id)


class QueueMessageService:
    """Service for managing queue messages."""

    def get_db(self) -> Session:
        """Get database session."""
        return SessionLocal()

    def _build_message_response(
        self, db_message: QueueMessage, sender: User
    ) -> QueueMessageResponse:
        """Build QueueMessageResponse from QueueMessage model."""
        return QueueMessageResponse(
            id=db_message.id,
            queueId=db_message.queue_id,
            sender=SenderInfo(
                id=sender.id,
                userName=sender.user_name,
                email=sender.email,
            ),
            sourceTaskId=db_message.source_task_id,
            sourceSubtaskIds=db_message.source_subtask_ids,
            contentSnapshot=[
                MessageContentSnapshot(**msg) for msg in db_message.content_snapshot
            ],
            note=db_message.note,
            priority=db_message.priority,
            status=db_message.status,
            processResult=db_message.process_result,
            processTaskId=db_message.process_task_id,
            createdAt=db_message.created_at,
            updatedAt=db_message.updated_at,
            processedAt=db_message.processed_at,
        )

    def list_messages(
        self,
        user_id: int,
        queue_id: int,
        status: Optional[QueueMessageStatus] = None,
        priority: Optional[QueueMessagePriority] = None,
        sender_user_id: Optional[int] = None,
        skip: int = 0,
        limit: int = 50,
        sort_by: str = "created_at",
        sort_order: str = "desc",
    ) -> Tuple[List[QueueMessageResponse], int, int]:
        """List messages in a queue with filtering and pagination."""
        with self.get_db() as db:
            # Build base query
            query = db.query(QueueMessage).filter(
                QueueMessage.queue_id == queue_id,
                QueueMessage.recipient_user_id == user_id,
                QueueMessage.status != QueueMessageStatus.ARCHIVED,
            )

            # Apply filters
            if status:
                query = query.filter(QueueMessage.status == status)
            if priority:
                query = query.filter(QueueMessage.priority == priority)
            if sender_user_id:
                query = query.filter(QueueMessage.sender_user_id == sender_user_id)

            # Get total count
            total = query.count()

            # Get unread count for this queue
            unread = (
                db.query(func.count(QueueMessage.id))
                .filter(
                    QueueMessage.queue_id == queue_id,
                    QueueMessage.recipient_user_id == user_id,
                    QueueMessage.status == QueueMessageStatus.UNREAD,
                )
                .scalar()
                or 0
            )

            # Apply sorting
            sort_col = getattr(QueueMessage, sort_by, QueueMessage.created_at)
            if sort_order == "desc":
                query = query.order_by(sort_col.desc())
            else:
                query = query.order_by(sort_col.asc())

            # Apply pagination
            messages = query.offset(skip).limit(limit).all()

            # Get sender info in batch
            sender_ids = list(set(m.sender_user_id for m in messages))
            senders = (
                db.query(User).filter(User.id.in_(sender_ids)).all()
                if sender_ids
                else []
            )
            sender_map = {s.id: s for s in senders}

            return (
                [
                    self._build_message_response(m, sender_map.get(m.sender_user_id))
                    for m in messages
                    if sender_map.get(m.sender_user_id)
                ],
                total,
                unread,
            )

    def get_message(
        self, user_id: int, message_id: int
    ) -> Optional[QueueMessageResponse]:
        """Get a specific queue message."""
        with self.get_db() as db:
            message = (
                db.query(QueueMessage)
                .filter(
                    QueueMessage.id == message_id,
                    QueueMessage.recipient_user_id == user_id,
                )
                .first()
            )
            if not message:
                return None

            sender = db.query(User).filter(User.id == message.sender_user_id).first()
            if not sender:
                return None

            return self._build_message_response(message, sender)

    def create_message(self, data: QueueMessageCreate) -> QueueMessage:
        """Create a new queue message."""
        with self.get_db() as db:
            db_message = QueueMessage(
                queue_id=data.queue_id,
                sender_user_id=data.sender_user_id,
                recipient_user_id=data.recipient_user_id,
                source_task_id=data.source_task_id,
                source_subtask_ids=data.source_subtask_ids,
                content_snapshot=[msg.model_dump() for msg in data.content_snapshot],
                note=data.note,
                priority=data.priority,
            )
            db.add(db_message)
            db.commit()
            db.refresh(db_message)

            logger.info(
                f"Created queue message: id={db_message.id}, "
                f"queue_id={data.queue_id}, sender={data.sender_user_id}"
            )

            return db_message

    def update_status(
        self, user_id: int, message_id: int, status: QueueMessageStatus
    ) -> QueueMessageResponse:
        """Update message status."""
        with self.get_db() as db:
            message = (
                db.query(QueueMessage)
                .filter(
                    QueueMessage.id == message_id,
                    QueueMessage.recipient_user_id == user_id,
                )
                .first()
            )
            if not message:
                raise NotFoundException("Queue message not found")

            message.status = status
            message.updated_at = datetime.now()
            if status == QueueMessageStatus.PROCESSED:
                message.processed_at = datetime.now()

            db.commit()
            db.refresh(message)

            sender = db.query(User).filter(User.id == message.sender_user_id).first()
            return self._build_message_response(message, sender)

    def update_priority(
        self, user_id: int, message_id: int, priority: QueueMessagePriority
    ) -> QueueMessageResponse:
        """Update message priority."""
        with self.get_db() as db:
            message = (
                db.query(QueueMessage)
                .filter(
                    QueueMessage.id == message_id,
                    QueueMessage.recipient_user_id == user_id,
                )
                .first()
            )
            if not message:
                raise NotFoundException("Queue message not found")

            message.priority = priority
            message.updated_at = datetime.now()
            db.commit()
            db.refresh(message)

            sender = db.query(User).filter(User.id == message.sender_user_id).first()
            return self._build_message_response(message, sender)

    def delete_message(self, user_id: int, message_id: int) -> bool:
        """Archive (soft delete) a queue message."""
        with self.get_db() as db:
            message = (
                db.query(QueueMessage)
                .filter(
                    QueueMessage.id == message_id,
                    QueueMessage.recipient_user_id == user_id,
                )
                .first()
            )
            if not message:
                raise NotFoundException("Queue message not found")

            message.status = QueueMessageStatus.ARCHIVED
            message.updated_at = datetime.now()
            db.commit()

            logger.info(f"Archived queue message: id={message_id}, user_id={user_id}")

            return True

    def get_unread_counts(self, user_id: int) -> Tuple[int, Dict[int, int]]:
        """Get unread message counts for all queues."""
        with self.get_db() as db:
            # Get counts grouped by queue
            results = (
                db.query(
                    QueueMessage.queue_id,
                    func.count(QueueMessage.id).label("count"),
                )
                .filter(
                    QueueMessage.recipient_user_id == user_id,
                    QueueMessage.status == QueueMessageStatus.UNREAD,
                )
                .group_by(QueueMessage.queue_id)
                .all()
            )

            by_queue = {r.queue_id: r.count for r in results}
            total = sum(by_queue.values())

            return total, by_queue

    def batch_update_status(
        self, user_id: int, message_ids: List[int], status: QueueMessageStatus
    ) -> Tuple[int, int, List[int]]:
        """Batch update message status.

        Returns:
            Tuple of (success_count, failed_count, failed_ids)
        """
        with self.get_db() as db:
            # Get all messages that belong to the user
            messages = (
                db.query(QueueMessage)
                .filter(
                    QueueMessage.id.in_(message_ids),
                    QueueMessage.recipient_user_id == user_id,
                )
                .all()
            )

            found_ids = {m.id for m in messages}
            failed_ids = [mid for mid in message_ids if mid not in found_ids]

            # Update all found messages
            now = datetime.now()
            for message in messages:
                message.status = status
                message.updated_at = now
                if status == QueueMessageStatus.PROCESSED:
                    message.processed_at = now

            db.commit()

            success_count = len(messages)
            failed_count = len(failed_ids)

            logger.info(
                f"Batch updated message status: user_id={user_id}, "
                f"status={status}, success={success_count}, failed={failed_count}"
            )

            return success_count, failed_count, failed_ids

    def batch_delete_messages(
        self, user_id: int, message_ids: List[int]
    ) -> Tuple[int, int, List[int]]:
        """Batch archive (soft delete) messages.

        Returns:
            Tuple of (success_count, failed_count, failed_ids)
        """
        with self.get_db() as db:
            # Get all messages that belong to the user
            messages = (
                db.query(QueueMessage)
                .filter(
                    QueueMessage.id.in_(message_ids),
                    QueueMessage.recipient_user_id == user_id,
                )
                .all()
            )

            found_ids = {m.id for m in messages}
            failed_ids = [mid for mid in message_ids if mid not in found_ids]

            # Archive all found messages
            now = datetime.now()
            for message in messages:
                message.status = QueueMessageStatus.ARCHIVED
                message.updated_at = now

            db.commit()

            success_count = len(messages)
            failed_count = len(failed_ids)

            logger.info(
                f"Batch deleted messages: user_id={user_id}, "
                f"success={success_count}, failed={failed_count}"
            )

            return success_count, failed_count, failed_ids


class ContactService:
    """Service for managing recent contacts."""

    def get_db(self) -> Session:
        """Get database session."""
        return SessionLocal()

    def record_contact(self, user_id: int, contact_user_id: int) -> None:
        """Record a contact interaction."""
        if user_id == contact_user_id:
            logger.debug(f"Skipping self-contact: user_id={user_id}")
            return

        logger.info(
            f"Recording contact: user_id={user_id}, contact_user_id={contact_user_id}"
        )
        with self.get_db() as db:
            contact = (
                db.query(RecentContact)
                .filter(
                    RecentContact.user_id == user_id,
                    RecentContact.contact_user_id == contact_user_id,
                )
                .first()
            )

            if contact:
                contact.last_contact_at = datetime.now()
                contact.contact_count += 1
            else:
                contact = RecentContact(
                    user_id=user_id,
                    contact_user_id=contact_user_id,
                )
                db.add(contact)

            db.commit()

    def get_recent_contacts(
        self, user_id: int, limit: int = 20
    ) -> List[Dict[str, Any]]:
        """Get recent contacts for a user."""
        with self.get_db() as db:
            contacts = (
                db.query(RecentContact)
                .filter(RecentContact.user_id == user_id)
                .order_by(RecentContact.last_contact_at.desc())
                .limit(limit)
                .all()
            )

            if not contacts:
                return []

            # Get user info in batch
            contact_user_ids = [c.contact_user_id for c in contacts]
            users = (
                db.query(User)
                .filter(User.id.in_(contact_user_ids), User.is_active == True)
                .all()
            )
            user_map = {u.id: u for u in users}

            return [
                {
                    "id": c.id,
                    "userId": c.contact_user_id,
                    "userName": user_map[c.contact_user_id].user_name,
                    "email": user_map[c.contact_user_id].email,
                    "lastContactAt": c.last_contact_at,
                    "contactCount": c.contact_count,
                }
                for c in contacts
                if c.contact_user_id in user_map
            ]


# Global service instances
work_queue_service = WorkQueueService()
queue_message_service = QueueMessageService()
contact_service = ContactService()
