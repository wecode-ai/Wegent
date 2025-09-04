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

class TaskStatus(str, PyEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    DELETE = "DELETE"

class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    k_id = Column(Integer, unique=True, index=True)
    user_name = Column(String(50), nullable=False)
    title = Column(String(256), nullable=False)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    git_url = Column(String(512), nullable=False)
    git_repo = Column(String(512), nullable=False)
    git_repo_id = Column(Integer)
    git_domain = Column(String(100))
    branch_name = Column(String(100), nullable=False)
    prompt = Column(Text, nullable=False)
    status = Column(SQLEnum(TaskStatus), nullable=False, default=TaskStatus.PENDING)
    progress = Column(Integer, nullable=False, default=0)
    batch = Column(Integer, nullable=False, default=0)
    result = Column(JSON)
    error_message = Column(Text)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    completed_at = Column(DateTime)

    # Relationships
    user = relationship("User", back_populates="tasks")
    team = relationship("Team")
    subtasks = relationship("Subtask", back_populates="task")

    __table_args__ = (
        {'sqlite_autoincrement': True,
         'mysql_engine': 'InnoDB',
         'mysql_charset': 'utf8mb4',
         'mysql_collate': 'utf8mb4_unicode_ci'},
    )