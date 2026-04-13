# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Work Queue database models for message forwarding and processing."""

from datetime import datetime, timezone

from sqlalchemy import JSON, Column, DateTime
from sqlalchemy import Enum as SQLEnum
from sqlalchemy import Index, Integer, String, Text

from .base import Base
from .enums import QueueMessagePriority, QueueMessageStatus


def utc_now():
    """Return current UTC time."""
    return datetime.now(timezone.utc)


class QueueMessage(Base):
    """Queue message model for forwarded messages."""

    __tablename__ = "queue_messages"

    id = Column(Integer, primary_key=True, index=True)
    queue_id = Column(
        Integer, nullable=False, index=True, comment="Work queue ID (kinds.id)"
    )
    sender_user_id = Column(
        Integer, nullable=False, index=True, comment="Sender user ID"
    )
    recipient_user_id = Column(
        Integer, nullable=False, index=True, comment="Recipient user ID (queue owner)"
    )
    source_task_id = Column(
        Integer, nullable=False, index=True, comment="Original task/conversation ID"
    )
    source_subtask_ids = Column(
        JSON, nullable=False, comment="List of original message IDs (subtask IDs)"
    )
    content_snapshot = Column(
        JSON,
        nullable=False,
        comment="Snapshot of message content including text and attachments",
    )
    note = Column(Text, nullable=False, default="", comment="Sender's note/comment")
    priority = Column(
        SQLEnum(
            QueueMessagePriority,
            values_callable=lambda x: [e.value for e in x],
        ),
        nullable=False,
        default=QueueMessagePriority.NORMAL,
        index=True,
    )
    status = Column(
        SQLEnum(
            QueueMessageStatus,
            values_callable=lambda x: [e.value for e in x],
        ),
        nullable=False,
        default=QueueMessageStatus.UNREAD,
        index=True,
    )
    process_result = Column(
        JSON, nullable=False, default=dict, comment="AI processing result"
    )
    process_task_id = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Task ID created for processing (0 = not processed)",
    )
    process_subscription_id = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Subscription Kind.id used for processing (0 = none)",
    )
    created_at = Column(DateTime, nullable=False, default=utc_now, index=True)
    updated_at = Column(DateTime, nullable=False, default=utc_now, onupdate=utc_now)
    processed_at = Column(
        DateTime, nullable=False, default=utc_now, comment="Processing completion time"
    )

    __table_args__ = (
        Index("ix_queue_messages_queue_status", "queue_id", "status"),
        Index("ix_queue_messages_recipient_status", "recipient_user_id", "status"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class RecentContact(Base):
    """Recent contact model for tracking user interactions."""

    __tablename__ = "recent_contacts"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True, comment="User ID")
    contact_user_id = Column(
        Integer, nullable=False, index=True, comment="Contact user ID"
    )
    last_contact_at = Column(
        DateTime, nullable=False, default=utc_now, comment="Last contact time"
    )
    contact_count = Column(Integer, nullable=False, default=1, comment="Contact count")

    __table_args__ = (
        Index("ix_recent_contacts_user_contact", "user_id", "contact_user_id"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
