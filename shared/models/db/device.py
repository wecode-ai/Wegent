# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Device database model for local device support."""

from sqlalchemy import Column, DateTime
from sqlalchemy import Enum as SQLEnum
from sqlalchemy import Index, Integer, String
from sqlalchemy.sql import func

from .base import Base
from .enums import DeviceStatus


class Device(Base):
    """
    Device model for local device registration and management.

    Local devices can execute tasks as an alternative to cloud Docker containers.
    Devices self-register via WebSocket with user JWT token authentication.
    """

    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, comment="Device owner user ID")
    name = Column(String(100), nullable=False, comment="Device name (self-provided)")
    device_id = Column(
        String(100),
        nullable=False,
        comment="Device unique identifier (self-generated, e.g., MAC/UUID)",
    )
    status = Column(
        SQLEnum(DeviceStatus),
        default=DeviceStatus.OFFLINE,
        comment="Device status: online, offline, busy",
    )
    last_heartbeat = Column(DateTime, nullable=True, comment="Last heartbeat time")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_device_user_id", "user_id"),
        Index("idx_device_device_id", "device_id"),
        Index("idx_device_status", "status"),
        Index("uniq_user_device", "user_id", "device_id", unique=True),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Local devices table for task execution",
        },
    )

    def __repr__(self) -> str:
        return f"<Device(id={self.id}, user_id={self.user_id}, device_id={self.device_id}, status={self.status})>"
