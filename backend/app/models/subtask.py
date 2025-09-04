# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from enum import Enum as PyEnum
from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, JSON, ForeignKey
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from sqlalchemy import Enum as SQLEnum

from app.db.base import Base

class SubtaskStatus(str, PyEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    DELETE = "DELETE"

class Subtask(Base):
    __tablename__ = "subtasks"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    title = Column(String(256), nullable=False)
    bot_id = Column(Integer, ForeignKey("bots.id"), nullable=False)
    executor_namespace = Column(String(100))
    executor_name = Column(String(100))
    prompt = Column(Text)
    sort_order = Column(Integer, nullable=False, default=0)
    status = Column(SQLEnum(SubtaskStatus), nullable=False, default=SubtaskStatus.PENDING)
    progress = Column(Integer, nullable=False, default=0)
    batch = Column(Integer, nullable=False, default=0)
    result = Column(JSON)
    error_message = Column(Text)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    completed_at = Column(DateTime)

    # Relationships
    user = relationship("User")
    task = relationship("Task", back_populates="subtasks")
    team = relationship("Team")
    bot = relationship("Bot")

    __table_args__ = (
        {'sqlite_autoincrement': True,
         'mysql_engine': 'InnoDB',
         'mysql_charset': 'utf8mb4',
         'mysql_collate': 'utf8mb4_unicode_ci'},
    )