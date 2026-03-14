# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Kubernetes-style CRD models for cloud-native agent management.
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, Index, Integer, String

from .base import Base


class Kind(Base):
    """Unified Kind model for all Kubernetes-style resources."""

    __tablename__ = "kinds"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False)
    kind = Column(String(50), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    namespace = Column(String(100), nullable=False, default="default")
    json = Column(JSON, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        # Composite index for user's own resources query:
        # SELECT * FROM kinds WHERE user_id=? AND kind=? AND namespace=? AND is_active=1
        Index(
            "ix_kinds_user_kind_ns_active", "user_id", "kind", "namespace", "is_active"
        ),
        # Composite index for group resources query:
        # SELECT * FROM kinds WHERE kind=? AND namespace=? AND is_active=1
        Index("ix_kinds_kind_ns_active", "kind", "namespace", "is_active"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
