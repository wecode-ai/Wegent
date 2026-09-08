"""Persistent Wework inbox entries, independent of delivery channels."""

from sqlalchemy import JSON, Column, DateTime, Index, Integer, String, Text

from app.db.base import Base


class WeworkNotification(Base):
    __tablename__ = "wework_notifications"
    __table_args__ = (
        Index("ix_wework_notifications_inbox", "user_id", "created_at", "id"),
    )

    id = Column(String(36), primary_key=True)
    user_id = Column(Integer, nullable=False)
    actor_user_id = Column(Integer, nullable=False)
    kind = Column(String(64), nullable=False)
    title = Column(String(256), nullable=False)
    body = Column(Text, nullable=False)
    url = Column(String(2048), nullable=True)
    payload = Column(JSON, nullable=False)
    created_at = Column(DateTime, nullable=False)
    read_at = Column(DateTime, nullable=True)
