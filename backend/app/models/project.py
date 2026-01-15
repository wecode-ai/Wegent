# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project model for organizing tasks into projects.

Projects are containers for tasks, allowing users to categorize and organize
their tasks. A task can belong to multiple projects (many-to-many relationship).
"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base


class Project(Base):
    """
    Project model for task organization.

    Projects allow users to group and categorize their tasks.
    Each project belongs to a single user and can contain multiple tasks.
    """

    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True, comment="Primary key")
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="Project owner user ID",
    )
    name = Column(
        String(100),
        nullable=False,
        comment="Project name",
    )
    description = Column(
        Text,
        nullable=True,
        default=None,
        comment="Project description",
    )
    color = Column(
        String(20),
        nullable=True,
        comment="Project color identifier (e.g., #FF5733)",
    )
    sort_order = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Sort order for display",
    )
    is_expanded = Column(
        Boolean,
        nullable=False,
        default=True,
        comment="Whether the project is expanded in UI",
    )
    is_active = Column(
        Boolean,
        nullable=False,
        default=True,
        comment="Whether the project is active (soft delete)",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        comment="Creation timestamp",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        onupdate=func.now(),
        comment="Last update timestamp",
    )

    # Relationships
    project_tasks = relationship(
        "ProjectTask",
        back_populates="project",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )

    __table_args__ = (
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Projects table for task organization",
        },
    )


class ProjectTask(Base):
    """
    Association table for Project-Task many-to-many relationship.

    Tracks which tasks belong to which projects, along with
    ordering information within each project.
    """

    __tablename__ = "project_tasks"

    id = Column(Integer, primary_key=True, index=True, comment="Primary key")
    project_id = Column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="Project ID",
    )
    task_id = Column(
        Integer,
        ForeignKey("tasks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="Task ID",
    )
    sort_order = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Sort order within the project",
    )
    added_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        comment="When the task was added to the project",
    )

    # Relationships
    project = relationship("Project", back_populates="project_tasks")
    task = relationship("TaskResource")

    __table_args__ = (
        UniqueConstraint("project_id", "task_id", name="uniq_project_task"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Project-Task association table",
        },
    )
