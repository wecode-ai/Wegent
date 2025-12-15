# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import JSON, Boolean, Column, DateTime
from sqlalchemy import Enum as SQLEnum
from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base


class SubtaskStatus(str, PyEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    DELETE = "DELETE"


class SubtaskRole(str, PyEnum):
    USER = "USER"
    ASSISTANT = "ASSISTANT"


class Subtask(Base):
    __tablename__ = "subtasks"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False)
    task_id = Column(Integer, nullable=False)
    team_id = Column(Integer, nullable=False)
    title = Column(String(256), nullable=False)
    bot_ids = Column(JSON, nullable=False)
    role = Column(SQLEnum(SubtaskRole), nullable=False, default=SubtaskRole.ASSISTANT)
    executor_namespace = Column(String(100))
    executor_name = Column(String(100))
    executor_deleted_at = Column(Boolean, nullable=False, default=False)
    prompt = Column(Text)
    message_id = Column(Integer, nullable=False, default=1)
    parent_id = Column(Integer, nullable=True)
    status = Column(
        SQLEnum(SubtaskStatus), nullable=False, default=SubtaskStatus.PENDING
    )
    progress = Column(Integer, nullable=False, default=0)
    result = Column(JSON)
    error_message = Column(Text)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    completed_at = Column(DateTime)

    # Relationship to SubtaskAttachment (no foreign key constraint, use primaryjoin)
    attachments = relationship(
        "SubtaskAttachment",
        primaryjoin="Subtask.id == foreign(SubtaskAttachment.subtask_id)",
        backref="subtask",
        viewonly=True,  # Read-only since no FK constraint
    )

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
