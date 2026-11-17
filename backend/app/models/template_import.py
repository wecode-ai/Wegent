# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Durable, actor-owned template operations and atomic resource receipts."""

from datetime import datetime, timezone

from sqlalchemy import (
    CHAR,
    JSON,
    BigInteger,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects import mysql

from app.db.base import Base

_DATETIME = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class TemplateImportOperation(Base):
    __tablename__ = "template_import_operations"

    id = Column(String(64), primary_key=True)
    project_id = Column(String(255), nullable=False)
    actor_user_id = Column(BigInteger, nullable=False)
    protocol_version = Column(Integer, nullable=False)
    intent_sha256 = Column(CHAR(64), nullable=False)
    intent_encrypted = Column(
        Text().with_variant(mysql.LONGTEXT(), "mysql"), nullable=False
    )
    manifest = Column(JSON, nullable=False)
    created_at = Column(_DATETIME, nullable=False, default=_utc_now)
    updated_at = Column(_DATETIME, nullable=False, default=_utc_now, onupdate=_utc_now)

    __table_args__ = (
        UniqueConstraint(
            "actor_user_id",
            "project_id",
            "protocol_version",
            "intent_sha256",
            name="uq_template_import_identity",
        ),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_bin",
        },
    )


class TemplateImportReceipt(Base):
    __tablename__ = "template_import_receipts"

    operation_id = Column(
        String(64),
        ForeignKey(
            "template_import_operations.id",
            name="fk_template_import_receipt_operation",
            ondelete="CASCADE",
        ),
        primary_key=True,
    )
    step_key = Column(String(200), primary_key=True)
    kind = Column(String(20), nullable=False)
    request_sha256 = Column(CHAR(64), nullable=False)
    resource_id = Column(String(255), nullable=False)
    completed_at = Column(_DATETIME, nullable=False, default=_utc_now)

    __table_args__ = (
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_bin",
        },
    )
