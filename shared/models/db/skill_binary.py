# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill binary storage model for Claude Code Skills ZIP packages.
"""

from datetime import datetime

from sqlalchemy import (Column, DateTime, ForeignKey, Integer, LargeBinary,
                        String)

from .base import Base


class SkillBinary(Base):
    """Skill binary data storage for ZIP packages."""

    __tablename__ = "skill_binaries"

    id = Column(Integer, primary_key=True, index=True)
    kind_id = Column(
        Integer, ForeignKey("kinds.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    binary_data = Column(LargeBinary, nullable=False)  # ZIP package binary data
    file_size = Column(Integer, nullable=False)  # File size in bytes
    file_hash = Column(String(64), nullable=False)  # SHA256 hash
    created_at = Column(DateTime, default=datetime.now)

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
