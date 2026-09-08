"""Persistent Wework inbox entries, independent of delivery channels."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    func,
)

from app.db.base import Base


class WeworkNotification(Base):
    __tablename__ = "wework_notifications"
    __table_args__ = (
        Index("idx_wework_notifications_inbox", "user_id", "created_at", "id"),
        {
            "comment": "Persistent Wework inbox notifications",
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
        },
    )

    id = Column(String(36), primary_key=True, comment="Notification UUID")
    user_id = Column(
        Integer, nullable=False, server_default="0", comment="Recipient user ID"
    )
    actor_user_id = Column(
        Integer, nullable=False, server_default="0", comment="Sender user ID"
    )
    kind = Column(
        String(64),
        nullable=False,
        server_default="message",
        comment="Notification kind",
    )
    title = Column(
        String(256), nullable=False, server_default="", comment="Notification title"
    )
    body = Column(Text, nullable=False, comment="Notification body")
    url = Column(
        String(2048),
        nullable=False,
        server_default="",
        comment="Click destination; empty means no navigation",
    )
    payload = Column(JSON, nullable=False, comment="Structured source context")
    created_at = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        comment="Creation time in UTC",
    )
    is_read = Column(
        Boolean,
        nullable=False,
        default=False,
        server_default="0",
        comment="Read state: 0 unread, 1 read",
    )
    read_status_changed_at = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        comment="Read state transition time in UTC",
    )

    @property
    def read_at(self) -> datetime | None:
        """Expose a read timestamp only after the unread-to-read transition."""
        return self.read_status_changed_at if self.is_read else None
