# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User database model."""

from sqlalchemy import JSON, Boolean, Column, DateTime, Integer, String
from sqlalchemy.sql import func

from .base import Base


class User(Base):
    """User model for authentication and preferences."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    user_name = Column(String(50), nullable=False, unique=True)
    password_hash = Column(String(256), nullable=False)
    email = Column(String(100))
    git_info = Column(JSON)
    is_active = Column(Boolean, default=True)
    # User role: admin or user (default)
    role = Column(String(20), nullable=False, default="user")
    # Authentication source: password, oidc, or unknown (for existing users)
    auth_source = Column(String(20), nullable=False, default="unknown")
    # User preferences (e.g., send_key: "enter" or "cmd_enter")
    preferences = Column(String(4096), nullable=False, default="{}")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Note: Relationships like shared_tasks are not included here
    # as they would create circular dependencies with Backend-specific models.
    # Use explicit queries in Backend when needed.

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
