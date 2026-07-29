# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database model for knowledge-base generated artifacts."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type

KNOWLEDGE_ARTIFACT_CONTENT_MAX_LENGTH = 12_000
KNOWLEDGE_ARTIFACT_ERROR_MESSAGE_MAX_LENGTH = 2_000
KNOWLEDGE_ARTIFACT_UNSET_ID = 0
KNOWLEDGE_ARTIFACT_UNSET_DATETIME = datetime(1970, 1, 1)


class KnowledgeArtifactRecord(Base):
    """Persist the stable identity and current state of one generated artifact."""

    __tablename__ = "knowledge_artifacts"

    artifact_id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        comment="Artifact UUID",
    )
    knowledge_base_id: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Owning knowledge base ID; 0 means unset",
    )
    artifact_type: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="briefing",
        server_default="briefing",
        comment="Artifact type: briefing or mind_map",
    )
    title: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="",
        server_default="",
        comment="Artifact title",
    )
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="queued",
        server_default="queued",
        comment="Lifecycle status",
    )
    task_id: Mapped[int] = mapped_column(
        big_integer_id_type(),
        nullable=False,
        default=KNOWLEDGE_ARTIFACT_UNSET_ID,
        server_default="0",
        comment="Related task ID; 0 means unset",
    )
    assistant_subtask_id: Mapped[int] = mapped_column(
        big_integer_id_type(),
        nullable=False,
        default=KNOWLEDGE_ARTIFACT_UNSET_ID,
        server_default="0",
        comment="Related assistant subtask ID; 0 means unset",
    )
    content: Mapped[str] = mapped_column(
        String(KNOWLEDGE_ARTIFACT_CONTENT_MAX_LENGTH),
        nullable=False,
        default="",
        server_default="",
        comment="Generated content; empty means unavailable",
    )
    source_document_ids: Mapped[list[int]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
        comment="Source document ID list",
    )
    generation_config: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        nullable=False,
        default=dict,
        comment="Generation configuration",
    )
    error_code: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        default="",
        server_default="",
        comment="Failure code; empty means no error",
    )
    error_message: Mapped[str] = mapped_column(
        String(KNOWLEDGE_ARTIFACT_ERROR_MESSAGE_MAX_LENGTH),
        nullable=False,
        default="",
        server_default="",
        comment="Failure message; empty means no error",
    )
    user_id: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Creator user ID; 0 means unset",
    )
    schema_version: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=1,
        server_default="1",
        comment="Content schema version",
    )
    version: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=1,
        server_default="1",
        comment="Record version",
    )
    attempt: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=1,
        server_default="1",
        comment="Generation attempt number",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=func.now(),
        server_default=func.now(),
        comment="Creation time",
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=func.now(),
        server_default=func.now(),
        onupdate=func.now(),
        comment="Last update time",
    )
    completed_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=KNOWLEDGE_ARTIFACT_UNSET_DATETIME,
        server_default="1970-01-01 00:00:00",
        comment="Completion time; Unix epoch means incomplete",
    )

    __table_args__ = (
        Index(
            "idx_knowledge_artifacts_kb_created",
            "knowledge_base_id",
            "created_at",
            "artifact_id",
        ),
        {
            "comment": "Knowledge base generated artifacts",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )
