# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API Key model for programmatic access.
"""

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.sql import func

from app.db.base import Base


class APIKey(Base):
    """API Key model for programmatic access."""

    __tablename__ = "api_keys"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    key_hash = Column(String(256), nullable=False, unique=True)  # SHA256 hash of key
    key_prefix = Column(
        String(16), nullable=False
    )  # Display prefix, e.g., "wg-abc123..."
    name = Column(String(100), nullable=False)  # User-defined name
    expires_at = Column(
        DateTime, nullable=False, default=datetime(9999, 12, 31, 23, 59, 59)
    )  # Default: never expires (far future date)
    last_used_at = Column(
        DateTime, nullable=False, default=func.now()
    )  # Last usage time
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
