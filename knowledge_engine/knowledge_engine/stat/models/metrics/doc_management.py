# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document management metric tables (upload trends, index status, chunk stats, etc.)."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Float, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class KbDocUploadTrend(StatBase):
    """Daily document upload trend rows grouped by KB, extension, source, and user."""

    __tablename__ = "kb_stat_doc_upload_trend"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    file_extension = Column(String(64), nullable=False)
    source_type = Column(String(64), nullable=False)
    user_id = Column(BigInteger, nullable=False)
    upload_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_upload_trend_date", "stat_date"),
        Index("idx_doc_upload_trend_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDocIndexStatus(StatBase):
    """Document index status distribution grouped by status and file extension."""

    __tablename__ = "kb_stat_doc_index_status"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    index_status = Column(String(64), nullable=False)
    file_extension = Column(String(64), nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_index_status_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDocIndexFailureRate(StatBase):
    """Document index failure rate grouped by file extension."""

    __tablename__ = "kb_stat_doc_index_failure_rate"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    file_extension = Column(String(64), nullable=False)
    total_count = Column(Integer, nullable=False, default=0)
    failed_count = Column(Integer, nullable=False, default=0)
    failure_rate = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_index_failure_rate_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDocSizeDistribution(StatBase):
    """Document size distribution across predefined size buckets."""

    __tablename__ = "kb_stat_doc_size_distribution"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    size_bucket = Column(String(32), nullable=False)
    doc_count = Column(Integer, nullable=False, default=0)
    total_size = Column(BigInteger, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_size_distribution_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDocUpdateFrequency(StatBase):
    """Document update frequency grouped by KB, extension, and index generation."""

    __tablename__ = "kb_stat_doc_update_frequency"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    file_extension = Column(String(64), nullable=False)
    index_generation = Column(Integer, nullable=False)
    doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_update_frequency_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDocTopicDistribution(StatBase):
    """Document topic distribution grouped by KB and topic."""

    __tablename__ = "kb_stat_doc_topic_distribution"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    topic = Column(String(255), nullable=False)
    doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_topic_distribution_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDocFolderDepth(StatBase):
    """Document folder depth distribution grouped by KB and depth level."""

    __tablename__ = "kb_stat_doc_folder_depth"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    depth = Column(Integer, nullable=False)
    folder_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_folder_depth_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDocChunkStrategy(StatBase):
    """Document chunking strategy distribution grouped by splitter type and file extension."""

    __tablename__ = "kb_stat_doc_chunk_strategy"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    splitter_type = Column(String(64), nullable=False)
    file_extension = Column(String(64), nullable=False)
    doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_chunk_strategy_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDocChunkCountDistribution(StatBase):
    """Document chunk count distribution across predefined chunk buckets."""

    __tablename__ = "kb_stat_doc_chunk_count_distribution"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    chunk_bucket = Column(String(32), nullable=False)
    doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_chunk_count_dist_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDocSummaryStatus(StatBase):
    """Document summary status distribution grouped by summary status."""

    __tablename__ = "kb_stat_doc_summary_status"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    summary_status = Column(String(64), nullable=False)
    doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_doc_summary_status_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbAvgDocLength(StatBase):
    """Per-KB average document length (content depth signal)."""

    __tablename__ = "kb_stat_kb_avg_doc_length"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    total_docs = Column(Integer, nullable=False, default=0)
    avg_doc_length = Column(Float, nullable=True)
    median_doc_length = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_kb_avg_doc_length_run", "run_id"),
        Index("idx_kb_avg_doc_length_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
