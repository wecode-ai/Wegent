# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from enum import Enum as PyEnum

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
)
from sqlalchemy import Enum as SQLEnum
from sqlalchemy import (
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.sql import func

from app.db.session import WikiBase


class WikiProject(WikiBase):
    """Wiki project model - supports multiple source types"""

    __tablename__ = "wiki_projects"

    id = Column(Integer, primary_key=True, index=True)
    project_name = Column(String(200), nullable=False, index=True)
    project_type = Column(String(50), nullable=False, default="git", index=True)
    source_type = Column(String(50), nullable=False, default="github", index=True)
    source_url = Column(String(500), nullable=False, unique=True)
    source_id = Column(String(100), nullable=True)
    source_domain = Column(String(100), nullable=True)
    description = Column(Text)
    ext = Column(JSON, comment="Project extension data")
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = ({"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},)


class WikiGenerationStatus(str, PyEnum):
    """Wiki generation status enum"""

    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class WikiGenerationType(str, PyEnum):
    """Wiki generation type enum"""

    FULL = "full"
    INCREMENTAL = "incremental"
    CUSTOM = "custom"


class WikiGeneration(WikiBase):
    """Wiki document generation version records model"""

    __tablename__ = "wiki_generations"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(
        Integer,
        ForeignKey("wiki_projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id = Column(Integer, nullable=False, index=True)
    task_id = Column(Integer, nullable=False, default=0, index=True)
    team_id = Column(Integer, nullable=False)
    generation_type = Column(
        SQLEnum(WikiGenerationType), nullable=False, default=WikiGenerationType.FULL
    )
    source_snapshot = Column(
        JSON, nullable=False, comment="Source snapshot information"
    )
    status = Column(
        SQLEnum(WikiGenerationStatus),
        nullable=False,
        default=WikiGenerationStatus.PENDING,
        index=True,
    )
    ext = Column(JSON, comment="Extension fields")
    created_at = Column(DateTime, default=func.now(), index=True)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    completed_at = Column(DateTime, nullable=False, default="1970-01-01 00:00:00")

    __table_args__ = (
        Index("idx_user_project", "user_id", "project_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )


class WikiContent(WikiBase):
    """Wiki document contents model"""

    __tablename__ = "wiki_contents"

    id = Column(Integer, primary_key=True, index=True)
    generation_id = Column(
        Integer,
        ForeignKey("wiki_generations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    type = Column(String(50), nullable=False, default="chapter", index=True)
    title = Column(String(500), nullable=False)
    content = Column(Text, nullable=False)
    parent_id = Column(Integer, nullable=False, default=0)
    ext = Column(JSON, comment="Content extension data")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = ({"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},)
