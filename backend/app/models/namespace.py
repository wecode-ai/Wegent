# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base


class Namespace(Base):
    """
    Group (Namespace) model for resource organization.

    Supports hierarchical structure with parent/child groups using name prefixes.
    Example: 'aaa/bbb' represents group 'bbb' under parent group 'aaa'.
    """

    __tablename__ = "namespace"

    id = Column(Integer, primary_key=True, index=True)
    # Unique identifier, immutable after creation
    # Sub-groups use prefix format (e.g., 'aaa/bbb')
    name = Column(String(100), nullable=False, unique=True, index=True)
    # Display name, can be modified
    display_name = Column(String(100), nullable=True)
    # Group owner user ID
    owner_user_id = Column(Integer, nullable=False, index=True)
    # Visibility: private, internal, public
    visibility = Column(String(20), nullable=False, default="private")
    # Group description
    description = Column(Text, nullable=False, default="")
    # Is group active
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Relationships
    members = relationship(
        "NamespaceMember",
        back_populates="namespace",
        cascade="all, delete-orphan",
        primaryjoin="Namespace.name == foreign(NamespaceMember.group_name)",
    )

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Group (Namespace) table for resource organization",
        },
    )

    def get_parent_name(self) -> str | None:
        """Get parent group name from hierarchical name."""
        if "/" not in self.name:
            return None
        return self.name.rsplit("/", 1)[0]

    def get_depth(self) -> int:
        """Get nesting depth (0 for root groups)."""
        return self.name.count("/")

    def is_subgroup_of(self, parent_name: str) -> bool:
        """Check if this group is a subgroup of the given parent."""
        return self.name.startswith(f"{parent_name}/")
