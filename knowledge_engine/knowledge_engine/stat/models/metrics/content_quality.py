# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Content quality metric tables.

These surface content-debt signals (thin documents, poor chunk sizing) that
the doc_management volume metrics do not capture.
"""

from sqlalchemy import BigInteger, Column, Date, DateTime, Float, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class ThinDocAlert(StatBase):
    """Per-KB daily share of thin documents (<=1 chunk)."""

    __tablename__ = "kb_stat_thin_doc_alert"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    total_docs = Column(Integer, nullable=False, default=0)
    thin_docs = Column(Integer, nullable=False, default=0)
    thin_doc_rate = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_thin_doc_run", "run_id"),
        Index("idx_thin_doc_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class DocChunkQuality(StatBase):
    """Global chunk-size quality distribution (undersized/healthy/oversized)."""

    __tablename__ = "kb_stat_doc_chunk_quality"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    chunk_quality_bucket = Column(String(64), nullable=False)
    doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_chunk_quality_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ContentFreshness(StatBase):
    """Global document freshness distribution by days since update."""

    __tablename__ = "kb_stat_content_freshness"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    freshness_bucket = Column(String(32), nullable=False)
    doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_content_freshness_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbContentFreshness(StatBase):
    """Per-KB content freshness rate (docs updated within 30 days)."""

    __tablename__ = "kb_stat_kb_content_freshness"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    total_docs = Column(Integer, nullable=False, default=0)
    fresh_docs = Column(Integer, nullable=False, default=0)
    fresh_rate = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_kb_content_freshness_run", "run_id"),
        Index("idx_kb_content_freshness_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class DuplicateDocSuspect(StatBase):
    """Per-KB likely-duplicate document rate (same size + extension)."""

    __tablename__ = "kb_stat_duplicate_doc_suspect"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    total_docs = Column(Integer, nullable=False, default=0)
    duplicate_docs = Column(Integer, nullable=False, default=0)
    duplicate_rate = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_duplicate_doc_run", "run_id"),
        Index("idx_duplicate_doc_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
