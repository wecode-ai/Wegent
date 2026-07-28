# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database model for knowledge-base generated artifacts."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type


class KnowledgeArtifactRecord(Base):
    """Persist the stable identity and current state of one generated artifact."""

    __tablename__ = "knowledge_artifacts"

    artifact_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    knowledge_base_id: Mapped[int] = mapped_column(Integer, nullable=False)
    artifact_type: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    task_id: Mapped[int | None] = mapped_column(big_integer_id_type(), nullable=True)
    assistant_subtask_id: Mapped[int | None] = mapped_column(
        big_integer_id_type(),
        nullable=True,
    )
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_document_ids: Mapped[list[int]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
    )
    generation_config: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        nullable=False,
        default=dict,
    )
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=func.now(),
        onupdate=func.now(),
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        Index(
            "ix_knowledge_artifacts_kb_created",
            "knowledge_base_id",
            "created_at",
            "artifact_id",
        ),
        Index(
            "ix_knowledge_artifacts_status_updated",
            "status",
            "updated_at",
        ),
        Index("ix_knowledge_artifacts_user_id", "user_id"),
        Index("ix_knowledge_artifacts_task_id", "task_id"),
        Index(
            "ix_knowledge_artifacts_assistant_subtask_id",
            "assistant_subtask_id",
        ),
    )
