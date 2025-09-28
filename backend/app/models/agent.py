# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import Column, Integer, String, DateTime, JSON, UniqueConstraint
from sqlalchemy.sql import func

from app.db.base import Base


class Agent(Base):
    __tablename__ = "agents"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    config = Column(JSON, nullable=False)  # Configuration, supported protocols or other information; consistent with models.config semantics
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("name", name="idx_agent_name"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )