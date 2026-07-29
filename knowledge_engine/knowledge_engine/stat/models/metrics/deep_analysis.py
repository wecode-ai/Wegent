# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deep analysis metric tables (health scores, rankings, alerts, patterns)."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Float, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class KbHealthScore(StatBase):
    """Per-KB daily health score with sub-dimension breakdown."""

    __tablename__ = "kb_stat_kb_health_score"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=True)
    kb_name = Column(String(255), nullable=True)
    namespace = Column(String(128), nullable=True)
    activity_score = Column(Float, nullable=True)
    index_success_score = Column(Float, nullable=True)
    enable_score = Column(Float, nullable=True)
    summary_score = Column(Float, nullable=True)
    health_score = Column(Float, nullable=True)
    # Formula version pins the weighting used for this row (v1 =
    # activity*0.3 + index_success*0.3 + enable*0.2 + summary*0.2).
    # Future weight changes bump the version so historical trend lines
    # are not silently mixed with a new formula.
    formula_version = Column(String(16), nullable=False, default="v1")
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_health_score_run", "run_id"),
        Index("idx_health_score_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class DocValueRanking(StatBase):
    """Document value ranking based on reference counts and freshness (cross-section)."""

    __tablename__ = "kb_stat_doc_value_ranking"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    document_id = Column(BigInteger, nullable=True)
    document_name = Column(String(255), nullable=True)
    kb_id = Column(BigInteger, nullable=True)
    rag_ref_count = Column(Integer, default=0)
    head_ref_count = Column(Integer, default=0)
    unique_users = Column(Integer, default=0)
    days_since_update = Column(Integer, default=0)
    value_score = Column(Float, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_doc_value_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class DocLifecycleTrace(StatBase):
    """Document lifecycle trace with index generation tracking (cross-section)."""

    __tablename__ = "kb_stat_doc_lifecycle_trace"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    document_id = Column(BigInteger, nullable=True)
    document_name = Column(String(255), nullable=True)
    kb_id = Column(BigInteger, nullable=True)
    file_extension = Column(String(64), nullable=True)
    index_status = Column(String(64), nullable=True)
    index_generation = Column(Integer, default=1)
    file_size = Column(BigInteger, default=0)
    created_at_doc = Column(DateTime, nullable=True)
    updated_at_doc = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_doc_lifecycle_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class UserPatternEvolution(StatBase):
    """User query pattern evolution tracked by month."""

    __tablename__ = "kb_stat_user_pattern_evolution"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    user_id = Column(BigInteger, nullable=True)
    user_name = Column(String(255), nullable=True)
    stat_month = Column(String(7), nullable=True)
    rag_count = Column(Integer, default=0)
    head_count = Column(Integer, default=0)
    rag_ratio = Column(Float, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_user_pattern_run", "run_id"),
        Index("idx_user_pattern_month", "stat_month"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbGrowthCurve(StatBase):
    """Per-KB growth curve with cumulative docs and members over time."""

    __tablename__ = "kb_stat_kb_growth_curve"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=True)
    kb_name = Column(String(255), nullable=True)
    stat_date = Column(Date, nullable=True)
    cumulative_docs = Column(Integer, default=0)
    cumulative_members = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_growth_curve_run", "run_id"),
        Index("idx_growth_curve_date", "stat_date"),
        Index("idx_growth_curve_kb", "kb_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class RagHeadVerifyRate(StatBase):
    """RAG vs HEAD verification rate tracked daily per KB."""

    __tablename__ = "kb_stat_rag_head_verify_rate"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=True)
    kb_id = Column(BigInteger, nullable=True)
    total_rag_calls = Column(Integer, default=0)
    verified_by_head = Column(Integer, default=0)
    verify_rate = Column(Float, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_rag_head_run", "run_id"),
        Index("idx_rag_head_date", "stat_date"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class UserSegmentation(StatBase):
    """User segmentation by activity level (cross-section)."""

    __tablename__ = "kb_stat_user_segmentation"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    segment = Column(String(64), nullable=True)
    user_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_user_seg_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
