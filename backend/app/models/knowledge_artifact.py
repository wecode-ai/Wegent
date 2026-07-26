# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database model for knowledge-base generated artifacts."""

from sqlalchemy import JSON, Column, DateTime, Index, Integer, String, Text
from sqlalchemy.sql import func

from app.db.base import Base
from shared.models.db.types import big_integer_id_type


class KnowledgeArtifactRecord(Base):
    """Persist the stable identity and current state of one generated artifact."""

    __tablename__ = "knowledge_artifacts"

    artifact_id = Column(String(36), primary_key=True)
    knowledge_base_id = Column(Integer, nullable=False)
    artifact_type = Column(String(32), nullable=False)
    title = Column(String(255), nullable=False)
    status = Column(String(32), nullable=False)
    task_id = Column(big_integer_id_type(), nullable=True)
    assistant_subtask_id = Column(big_integer_id_type(), nullable=True)
    content = Column(Text, nullable=True)
    source_document_ids = Column(JSON, nullable=False, default=list)
    generation_config = Column(JSON, nullable=False, default=dict)
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    user_id = Column(Integer, nullable=False)
    schema_version = Column(Integer, nullable=False, default=1)
    version = Column(Integer, nullable=False, default=1)
    attempt = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        onupdate=func.now(),
    )
    completed_at = Column(DateTime, nullable=True)

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
