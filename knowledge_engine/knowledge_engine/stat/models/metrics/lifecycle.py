# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""KB lifecycle metric tables."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Float, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class KbCreationTrend(StatBase):
    """Daily KB creation counts by namespace with cumulative window."""

    __tablename__ = "kb_stat_kb_creation_trend"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    namespace = Column(String(128), nullable=True)
    new_kb_count = Column(Integer, nullable=False)
    cumulative_kb_count = Column(Integer, nullable=False)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_creation_run", "run_id"),
        Index("idx_creation_date", "stat_date"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbTopicDistribution(StatBase):
    """KB topic label distribution (cross-section)."""

    __tablename__ = "kb_stat_kb_topic_distribution"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    topic = Column(String(255), nullable=True)
    kb_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_topic_dist_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbRetrievalConfig(StatBase):
    """KB retrieval config preference distribution (cross-section)."""

    __tablename__ = "kb_stat_kb_retrieval_config"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    retrieval_mode = Column(String(64), nullable=True)
    top_k = Column(Integer, nullable=True)
    score_threshold = Column(Float, nullable=True)
    kb_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_retrieval_config_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbSizeDistribution(StatBase):
    """Per-KB daily size distribution."""

    __tablename__ = "kb_stat_kb_size_distribution"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    kb_name = Column(String(255), nullable=True)
    namespace = Column(String(128), nullable=True)
    doc_count = Column(Integer, nullable=False, default=0)
    total_file_size = Column(BigInteger, nullable=False, default=0)
    avg_file_size = Column(BigInteger, nullable=True)
    max_file_size = Column(BigInteger, nullable=True)
    size_bucket = Column(String(32), nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_size_dist_run", "run_id"),
        Index("idx_size_dist_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbAbandonRate(StatBase):
    """KB daily abandon rate by namespace."""

    __tablename__ = "kb_stat_kb_abandon_rate"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    namespace = Column(String(128), nullable=True)
    total_kb_count = Column(Integer, nullable=False, default=0)
    stale_kb_count = Column(Integer, nullable=False, default=0)
    inactive_kb_count = Column(Integer, nullable=False, default=0)
    abandon_rate = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_abandon_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbSharing(StatBase):
    """Per-KB sharing degree with member role breakdown (cross-section)."""

    __tablename__ = "kb_stat_kb_sharing"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    kb_name = Column(String(255), nullable=True)
    member_count = Column(Integer, nullable=False, default=0)
    share_link_count = Column(Integer, nullable=False, default=0)
    owner_count = Column(Integer, nullable=False, default=0)
    maintainer_count = Column(Integer, nullable=False, default=0)
    developer_count = Column(Integer, nullable=False, default=0)
    reporter_count = Column(Integer, nullable=False, default=0)
    restricted_analyst_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_sharing_run", "run_id"),
        Index("idx_sharing_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbActivity(StatBase):
    """Per-KB activity snapshot (cross-section, no stat_date)."""

    __tablename__ = "kb_stat_kb_activity"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    kb_namespace = Column(String(128), nullable=True)
    kb_name = Column(String(255), nullable=True)
    document_count = Column(Integer, nullable=True)
    last_doc_uploaded_at = Column(DateTime, nullable=True)
    last_query_at = Column(DateTime, nullable=True)
    is_stale = Column(Integer, nullable=True)  # TINYINT: 0/1
    is_inactive = Column(Integer, nullable=True)  # TINYINT: 0/1
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_activity_run", "run_id"),
        Index("idx_activity_kb", "kb_id", "target_date"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbConfigSanity(StatBase):
    """Per-KB retrieval config sanity issues (cross-section, multi-row)."""

    __tablename__ = "kb_stat_kb_config_sanity"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    kb_name = Column(String(255), nullable=True)
    issue_type = Column(String(64), nullable=False)
    issue_detail = Column(String(255), nullable=True)
    config_value = Column(String(128), nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_config_sanity_run", "run_id"),
        Index("idx_config_sanity_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
