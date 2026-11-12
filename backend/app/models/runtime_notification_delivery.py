# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schema metadata for Rust-owned Runtime notification delivery."""

from sqlalchemy import JSON, BigInteger, Column, DateTime, Index, Integer, String
from sqlalchemy.dialects import mysql

from app.db.base import Base

_DATETIME = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")
_ATTEMPTS = Integer().with_variant(mysql.INTEGER(unsigned=True), "mysql")


class RuntimeNotificationDelivery(Base):
    __tablename__ = "runtime_notification_deliveries"
    __table_args__ = (
        Index("ix_runtime_notification_due", "status", "next_attempt_at", "id"),
        Index("ix_runtime_notification_user", "user_id", "created_at"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id = Column(String(128), primary_key=True)
    user_id = Column(BigInteger, nullable=False)
    payload = Column(JSON, nullable=False)
    status = Column(String(16), nullable=False, server_default="pending")
    provider_result = Column(JSON, nullable=True)
    attempts = Column(_ATTEMPTS, nullable=False, server_default="0")
    next_attempt_at = Column(_DATETIME, nullable=False)
    lease_token = Column(String(64), nullable=True)
    created_at = Column(_DATETIME, nullable=False)
    updated_at = Column(_DATETIME, nullable=False)
