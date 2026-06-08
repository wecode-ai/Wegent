# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Binary storage model for Skill and plugin ZIP packages.
"""

from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, LargeBinary, String
from sqlalchemy.dialects.mysql import MEDIUMBLOB

from .base import Base

SkillBinaryDataType = LargeBinary().with_variant(MEDIUMBLOB, "mysql")


class SkillBinary(Base):
    """Binary data storage for Skill and plugin ZIP packages."""

    __tablename__ = "skill_binaries"

    id = Column(Integer, primary_key=True, index=True)
    kind_id = Column(
        Integer, ForeignKey("kinds.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    binary_data = Column(SkillBinaryDataType, nullable=False)  # ZIP package binary data
    file_size = Column(Integer, nullable=False)  # File size in bytes
    file_hash = Column(String(64), nullable=False)  # SHA256 hash
    type = Column(String(32), nullable=False, default="")  # Empty value means Skill
    file_name = Column(String(255), nullable=False, default="")
    created_at = Column(DateTime, default=datetime.now)

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
