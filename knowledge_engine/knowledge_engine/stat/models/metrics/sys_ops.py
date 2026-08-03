# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""System operations metric tables (storage usage, attachment, index views)."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class StorageUsage(StatBase):
    """Per-KB storage usage snapshot (cross-section)."""

    __tablename__ = "kb_stat_storage_usage"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=True)
    kb_name = Column(String(255), nullable=True)
    namespace = Column(String(128), nullable=True)
    total_file_size = Column(BigInteger, default=0)
    doc_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_storage_usage_run", "run_id"),
        Index("idx_storage_usage_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class AttachmentStorage(StatBase):
    """Attachment storage aggregated by backend type (cross-section)."""

    __tablename__ = "kb_stat_attachment_storage"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    storage_backend = Column(String(64), nullable=True)
    file_count = Column(Integer, default=0)
    total_size = Column(BigInteger, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_attachment_storage_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class DocIndexStorageView(StatBase):
    """Document index storage view by status and file extension (cross-section)."""

    __tablename__ = "kb_stat_doc_index_storage_view"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    index_status = Column(String(64), nullable=True)
    file_extension = Column(String(64), nullable=True)
    doc_count = Column(Integer, default=0)
    total_file_size = Column(BigInteger, default=0)
    avg_file_size = Column(BigInteger, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_doc_index_storage_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
