"""
DataVersion model for tracking data versioning.
"""
from datetime import datetime

from sqlalchemy import BigInteger, Column, DateTime, Integer, String, Text

from app.core.database import Base


class DataVersion(Base):
    """Model for tracking data versions."""

    __tablename__ = "data_versions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    name = Column(String(50), nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_sync_time = Column(DateTime, nullable=True)
    sync_count = Column(Integer, default=0, nullable=False)

    def __repr__(self) -> str:
        return f"<DataVersion(id={self.id}, name={self.name}, sync_count={self.sync_count})>"
