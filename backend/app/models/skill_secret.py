# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill Secret model for storing sensitive skill configurations per Ghost
"""
from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)

from app.db.base import Base


class SkillSecret(Base):
    """Store user-configured sensitive information for Skills (like API keys)

    This is used for MCP type skills that require environment variables
    containing sensitive data (API keys, tokens, etc.)
    """

    __tablename__ = "skill_secrets"

    id = Column(Integer, primary_key=True, index=True)

    # Associated Ghost (Kind table id for Ghost resources)
    ghost_id = Column(Integer, nullable=False, index=True)

    # Associated Skill (Kind table id for Skill resources)
    skill_id = Column(Integer, nullable=False, index=True)

    # Encrypted environment variable values (AES-256-CBC encrypted JSON)
    # {"GITHUB_PERSONAL_ACCESS_TOKEN": "encrypted_value", ...}
    encrypted_env = Column(Text, nullable=False)

    # Audit
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        UniqueConstraint("ghost_id", "skill_id", name="uq_ghost_skill_secret"),
        Index("idx_skill_secret_ghost", "ghost_id"),
        Index("idx_skill_secret_skill", "skill_id"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Sensitive skill configurations per Ghost",
        },
    )
