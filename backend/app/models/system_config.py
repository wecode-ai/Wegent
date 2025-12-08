# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SystemConfig model for storing system-wide configurations like quick access recommendations.
"""

from datetime import datetime

from sqlalchemy import JSON, Column, DateTime, Integer, String
from sqlalchemy.sql import func

from app.db.base import Base


class SystemConfig(Base):
    """
    System configuration model for storing key-value configurations.
    Used for features like system-recommended quick access teams.
    """

    __tablename__ = "system_configs"

    id = Column(Integer, primary_key=True, index=True)
    config_key = Column(String(100), nullable=False, unique=True, index=True)
    config_value = Column(JSON, nullable=False, default={})
    version = Column(Integer, nullable=False, default=1)
    updated_by = Column(Integer, nullable=True)  # User ID who last updated
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
