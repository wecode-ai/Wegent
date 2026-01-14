"""
SyncJob model for tracking data synchronization tasks.
"""
import enum
from datetime import datetime
from typing import Optional

from sqlalchemy import (
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

from app.core.database import Base


class SyncStatus(str, enum.Enum):
    """Status of a sync job."""

    STARTED = "started"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class SyncJob(Base):
    """Model for tracking data synchronization jobs."""

    __tablename__ = "sync_jobs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    sync_id = Column(String(36), unique=True, nullable=False, index=True)

    # Sync parameters
    start_time = Column(DateTime, nullable=False)
    end_time = Column(DateTime, nullable=False)
    user_id = Column(BigInteger, nullable=True)

    # Version ID for data versioning
    version_id = Column(
        BigInteger,
        ForeignKey("data_versions.id"),
        nullable=True,
        index=True,
    )

    # Status tracking
    status = Column(
        Enum(SyncStatus, values_callable=lambda x: [e.value for e in x]),
        default=SyncStatus.STARTED,
        nullable=False,
    )
    total_fetched = Column(Integer, default=0, nullable=False)
    total_inserted = Column(Integer, default=0, nullable=False)
    total_skipped = Column(Integer, default=0, nullable=False)
    error_message = Column(Text, nullable=True)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    __table_args__ = (
        Index("idx_sync_id", "sync_id", unique=True),
        Index("idx_status", "status"),
        Index("idx_created_at", "created_at"),
        Index("idx_sj_version_id", "version_id"),
    )

    def __repr__(self) -> str:
        return f"<SyncJob(sync_id={self.sync_id}, status={self.status})>"
