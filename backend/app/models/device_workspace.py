# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Central mapping between Wegent projects and local device directories."""

from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.sql import func

from app.db.base import Base


class DeviceWorkspace(Base):
    """User-owned mapping from one device directory to one Project."""

    __tablename__ = "device_workspaces"

    id = Column(Integer, primary_key=True, index=True, comment="Primary key")
    user_id = Column(Integer, nullable=False, index=True, comment="Owner user ID")
    project_id = Column(Integer, nullable=False, index=True, comment="Project ID")
    device_id = Column(String(128), nullable=False, index=True, comment="Device ID")
    workspace_path = Column(
        Text,
        nullable=False,
        comment="Absolute workspace path on the local device",
    )
    repo_url = Column(Text, nullable=True, comment="Optional repository URL")
    repo_root_fingerprint = Column(
        String(128),
        nullable=True,
        comment="Optional local repository root fingerprint",
    )
    label = Column(String(255), nullable=True, comment="User-facing workspace label")
    last_seen_at = Column(
        DateTime,
        nullable=True,
        comment="Last time the owning executor reported this workspace",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        comment="Creation timestamp",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        onupdate=func.now(),
        comment="Last update timestamp",
    )

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "device_id",
            "workspace_path",
            name="uq_device_workspace_user_device_path",
        ),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Central mappings from Projects to device-local workspaces",
        },
    )
