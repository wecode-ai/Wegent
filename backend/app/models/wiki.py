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
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.db.session import WikiBase
from shared.models.db.types import big_integer_id_type


class WikiProject(WikiBase):
    """Wiki project model - supports multiple source types"""

    __tablename__ = "wiki_projects"

    id = Column(Integer, primary_key=True, index=True)
    project_name = Column(String(200), nullable=False, index=True)
    project_type = Column(String(50), nullable=False, default="git", index=True)
    source_type = Column(String(50), nullable=False, default="github", index=True)
    source_url = Column(String(500), nullable=False)
    # NOT NULL with an empty default, matching `wiki_tables.sql`, which every
    # deployment is built from. Declared nullable here, the ORM-created schema used by
    # tests accepted a NULL that production refuses -- so an insert that omitted one
    # of these passed every test and failed on the first real database.
    source_id = Column(String(100), nullable=False, default="", server_default="")
    source_domain = Column(String(100), nullable=False, default="", server_default="")
    description = Column(Text, nullable=False, default="")
    ext = Column(JSON, nullable=False, default=dict, comment="Project extension data")
    # The code wiki this row registers, or 0 for a legacy wiki project. One row per
    # (repository, wiki): a code wiki belongs to its creator, so a repository may
    # have several, one per person who built one.
    kind_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        index=True,
        comment="Code wiki knowledge base built from this repository; 0 = legacy",
    )
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = (
        # The pair rather than the URL alone. It is what settles two requests racing
        # for the same (repository, wiki), which a check against a JSON field on the
        # knowledge base could not — that leaves a window between read and insert
        # exactly where it matters. Legacy rows carry kind_id = 0 and are therefore
        # still limited to one per repository.
        UniqueConstraint(
            "source_url", "kind_id", name="uq_wiki_projects_source_url_kind_id"
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


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
    # Knowledge base this version line belongs to (references kinds.id, no FK).
    # Versions are owned by the KB rather than by the project: wiki_projects.source_url
    # is globally unique, so project-scoped versions would be shared between knowledge
    # bases tracking the same repository. 0 marks a row predating code_wiki.
    kind_id = Column(Integer, nullable=False, default=0, server_default="0", index=True)
    user_id = Column(Integer, nullable=False, index=True)
    task_id = Column(big_integer_id_type(), nullable=False, default=0, index=True)
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
    ext = Column(JSON, nullable=False, default=dict, comment="Extension fields")
    created_at = Column(DateTime, default=func.now(), index=True)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    completed_at = Column(DateTime, nullable=False, default="1970-01-01 00:00:00")

    __table_args__ = (
        Index("idx_user_project", "user_id", "project_id"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
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
    ext = Column(JSON, nullable=False, default=dict, comment="Content extension data")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
