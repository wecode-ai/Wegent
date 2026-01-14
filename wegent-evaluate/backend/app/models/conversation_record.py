"""
ConversationRecord model for storing historical conversation data.
"""
import enum
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from app.core.database import Base


class EvaluationStatus(str, enum.Enum):
    """Status of evaluation for a conversation record."""

    PENDING = "pending"
    SKIPPED = "skipped"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class ConversationRecord(Base):
    """Model for storing historical conversation records."""

    __tablename__ = "conversation_records"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    task_id = Column(BigInteger, nullable=False, index=True)
    user_id = Column(BigInteger, nullable=False, index=True)
    subtask_id = Column(BigInteger, nullable=False, index=True)
    subtask_context_id = Column(BigInteger, unique=True, nullable=False)

    # Version ID for data versioning
    version_id = Column(
        BigInteger,
        ForeignKey("data_versions.id"),
        nullable=False,
        index=True,
    )

    # Conversation content
    user_prompt = Column(Text, nullable=False)
    assistant_answer = Column(Text, nullable=False)
    extracted_text = Column(Text, nullable=True)

    # Raw JSON data
    knowledge_base_result = Column(JSON, nullable=True)
    knowledge_base_config = Column(JSON, nullable=True)

    # Extracted fields for filtering
    knowledge_id = Column(Integer, nullable=True, index=True)
    knowledge_name = Column(String(255), nullable=True)
    retriever_name = Column(String(255), nullable=True, index=True)
    embedding_model = Column(String(255), nullable=True, index=True)
    retrieval_mode = Column(String(50), nullable=True)

    # Timestamps
    original_created_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Evaluation status
    evaluation_status = Column(
        Enum(EvaluationStatus, values_callable=lambda x: [e.value for e in x]),
        default=EvaluationStatus.PENDING,
        nullable=False,
        index=True,
    )
    skip_reason = Column(String(255), nullable=True)

    # Relationship to evaluation result
    evaluation_result = relationship(
        "EvaluationResult",
        back_populates="conversation_record",
        uselist=False,
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("idx_subtask_context_id", "subtask_context_id", unique=True),
        Index("idx_evaluation_status", "evaluation_status"),
        Index("idx_original_created_at", "original_created_at"),
        Index("idx_retriever_name", "retriever_name"),
        Index("idx_embedding_model", "embedding_model"),
        Index("idx_knowledge_id", "knowledge_id"),
        Index("idx_cr_version_id", "version_id"),
    )

    def __repr__(self) -> str:
        return f"<ConversationRecord(id={self.id}, subtask_context_id={self.subtask_context_id})>"
