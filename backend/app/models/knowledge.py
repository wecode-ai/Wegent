# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base and document models for document knowledge management.

Provides storage for user and team knowledge bases with document management.
"""

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    JSON,
)
from sqlalchemy import Enum as SQLEnum
from sqlalchemy import (
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base


class DocumentStatus(str, PyEnum):
    """Document status for knowledge documents."""

    ENABLED = "enabled"
    DISABLED = "disabled"


class KnowledgeDocument(Base):
    """
    Knowledge document model for storing document metadata.

    Links to subtask_attachments table for actual file storage.
    Note: kind_id references kinds.id (Kind='KnowledgeBase')
    Note: attachment_id references subtask_attachments.id but without FK constraint
          (referential integrity is managed at the application layer)
    """

    __tablename__ = "knowledge_documents"

    id = Column(Integer, primary_key=True, index=True)
    # References kinds.id (Kind='KnowledgeBase') but without FK constraint
    # Referential integrity is managed at the application layer
    kind_id = Column(Integer, nullable=False, index=True)
    # References subtask_attachments.id but without FK constraint
    # Referential integrity is managed at the application layer
    attachment_id = Column(Integer, nullable=True)
    name = Column(String(255), nullable=False)
    file_extension = Column(String(50), nullable=False)
    file_size = Column(BigInteger, nullable=False, default=0)
    status = Column(
        SQLEnum(DocumentStatus, values_callable=lambda obj: [e.value for e in obj]),
        nullable=False,
        default=DocumentStatus.ENABLED,
    )
    user_id = Column(Integer, nullable=False, index=True)
    is_active = Column(Boolean, nullable=False, default=True)
    splitter_config = Column(JSON, nullable=True)  # Splitter configuration for document chunking
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        # Index for listing documents in a knowledge base
        Index(
            "ix_knowledge_documents_kind_active_created",
            "kind_id",
            "is_active",
            "created_at",
        ),
        # Index for attachment lookup
        Index("ix_knowledge_documents_attachment", "attachment_id"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Knowledge document table for file metadata",
        },
    )
