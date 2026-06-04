# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Installed plugin package storage model for Claude Code plugin ZIP files."""

from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, LargeBinary, String
from sqlalchemy.dialects.mysql import MEDIUMBLOB

from .base import Base

PluginPackageDataType = LargeBinary().with_variant(MEDIUMBLOB, "mysql")


class InstalledPluginPackage(Base):
    """Binary package data for user-installed Claude Code plugins."""

    __tablename__ = "installed_plugin_packages"

    id = Column(Integer, primary_key=True, index=True)
    kind_id = Column(
        Integer, ForeignKey("kinds.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    binary_data = Column(PluginPackageDataType, nullable=False)
    file_size = Column(Integer, nullable=False)
    file_hash = Column(String(64), nullable=False)
    file_name = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
