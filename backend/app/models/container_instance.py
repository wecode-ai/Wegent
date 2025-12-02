# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Container instance model for persistent container management
"""
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    Index,
    String,
    Text,
)

from app.db.base import Base


class ContainerInstance(Base):
    """Container instance model for tracking persistent containers"""

    __tablename__ = "container_instances"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, nullable=False, index=True)
    shell_id = Column(BigInteger, nullable=False, index=True)
    container_id = Column(String(64), unique=True, nullable=True)  # Docker container ID
    access_url = Column(String(500), nullable=True)  # Container access URL (WebSocket/API)
    status = Column(String(20), nullable=False, default="pending")  # pending/creating/running/stopped/error
    repo_url = Column(String(500), nullable=True)  # Cloned repository URL
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)
    last_task_at = Column(DateTime, nullable=True)  # Last task execution time
    error_message = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_container_status", "status"),
        Index("idx_user_shell", "user_id", "shell_id"),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )
