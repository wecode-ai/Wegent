"""A user's subscription to an Issue, independent of access and ownership."""

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects import mysql

from app.db.base import Base


class IssueFollower(Base):
    __tablename__ = "issue_followers"
    __table_args__ = (Index("ix_issue_followers_user_issue", "user_id", "issue_id"),)

    issue_id = Column(
        String(64), ForeignKey("loop_items.id", ondelete="CASCADE"), primary_key=True
    )
    user_id = Column(Integer, primary_key=True)
    created_at = Column(
        DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql"),
        nullable=False,
        server_default=func.now(6),
    )
