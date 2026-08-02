# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Database claims that make feedback submission idempotent."""

from sqlalchemy import Column, DateTime, ForeignKey, String, func

from app.db.base import Base


class FeedbackSubmission(Base):
    """Atomically claim one feedback report within a configured project."""

    __tablename__ = "feedback_submissions"

    project_id = Column(
        String(64),
        ForeignKey("loop_items.id", ondelete="CASCADE"),
        primary_key=True,
    )
    report_id = Column(String(64), primary_key=True)
    item_id = Column(String(64), nullable=True)
    claim_token = Column(String(36), nullable=False)
    claimed_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
