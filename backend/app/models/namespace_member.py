# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base


class NamespaceMember(Base):
    """
    Group membership model.

    Stores user membership in groups with role-based permissions.
    Roles: Owner, Maintainer, Developer, Reporter
    """

    __tablename__ = "namespace_members"

    id = Column(Integer, primary_key=True, index=True)
    # References namespace.name
    group_name = Column(String(100), nullable=False, index=True)
    # Member user ID
    user_id = Column(Integer, nullable=False, index=True)
    # Member role: Owner, Maintainer, Developer, Reporter
    role = Column(String(20), nullable=False)
    # User ID who invited this member (0 for self-created/owner)
    invited_by_user_id = Column(Integer, nullable=False, default=0)
    # Is membership active
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Relationships (no foreign key constraints as per requirements)
    namespace = relationship(
        "Namespace",
        back_populates="members",
        primaryjoin="NamespaceMember.group_name == Namespace.name",
        foreign_keys="[NamespaceMember.group_name]",
    )

    __table_args__ = (
        UniqueConstraint("group_name", "user_id", name="idx_group_user"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Group membership table",
        },
    )
