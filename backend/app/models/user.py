# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, Integer, String
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    user_name = Column(String(50), nullable=False, unique=True)
    password_hash = Column(String(256), nullable=False)
    email = Column(String(100))
    git_info = Column(JSON)
    is_active = Column(Boolean, default=True)
    # Authentication source: password, oidc, or unknown (for existing users)
    auth_source = Column(String(20), nullable=False, default="unknown")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Relationships
    shared_tasks = relationship("SharedTask", foreign_keys="[SharedTask.user_id]", back_populates="user")

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
