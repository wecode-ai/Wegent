# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.db.base import Base


class PublicShell(Base):
    __tablename__ = "public_shells"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    json = Column(JSON, nullable=False, comment="Resource-specific data in JSON format")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("name", "namespace", name="idx_public_shell_name_namespace"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
