# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tool Secret model for storing sensitive tool configurations per Ghost
"""
from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)

from app.db.base import Base


class ToolSecret(Base):
    """Store user-configured sensitive information for Tools (like API keys)"""

    __tablename__ = "tool_secrets"

    id = Column(Integer, primary_key=True, index=True)

    # Associated Ghost (Kind table id for Ghost resources)
    ghost_id = Column(Integer, nullable=False, index=True)

    # Associated Tool
    tool_id = Column(Integer, ForeignKey("tools.id", ondelete="CASCADE"), nullable=False, index=True)

    # Encrypted environment variable values (AES-256-CBC encrypted JSON)
    # {"GITHUB_PERSONAL_ACCESS_TOKEN": "encrypted_value", ...}
    encrypted_env = Column(Text, nullable=False)

    # Audit
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        UniqueConstraint("ghost_id", "tool_id", name="uq_ghost_tool_secret"),
        Index("idx_tool_secret_ghost", "ghost_id"),
        Index("idx_tool_secret_tool", "tool_id"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Sensitive tool configurations per Ghost",
        },
    )
