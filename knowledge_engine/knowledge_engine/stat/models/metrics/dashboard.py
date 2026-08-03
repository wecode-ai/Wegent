# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dashboard metric tables (global totals, period totals, daily detail)."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class GlobalTotals(StatBase):
    """Single-row snapshot of global KB/document/dingtalk counts per run."""

    __tablename__ = "kb_stat_global_totals"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False, unique=True)
    target_date = Column(Date, nullable=False)
    total_kb_count = Column(Integer, nullable=False, default=0)
    total_doc_count = Column(Integer, nullable=False, default=0)
    dingtalk_synced_user_count = Column(Integer, nullable=False, default=0)
    dingtalk_kb_count = Column(Integer, nullable=False, default=0)
    dingtalk_doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_global_totals_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class PeriodTotals(StatBase):
    """Period cumulative totals for queries/KB/docs per run."""

    __tablename__ = "kb_stat_period_totals"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    period_total_queries = Column(Integer, nullable=False, default=0)
    period_new_kb = Column(Integer, nullable=False, default=0)
    period_new_docs = Column(Integer, nullable=False, default=0)
    period_rag_queries = Column(Integer, nullable=False, default=0)
    period_direct_inject = Column(Integer, nullable=False, default=0)
    period_kb_head_queries = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_period_totals_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class DailyDashboard(StatBase):
    """Daily detail rows powering trend charts and detail table."""

    __tablename__ = "kb_stat_daily_dashboard"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    total_queries = Column(Integer, nullable=False, default=0)
    rag_queries = Column(Integer, nullable=False, default=0)
    direct_injection = Column(Integer, nullable=False, default=0)
    kb_head_rag_queries = Column(Integer, nullable=False, default=0)
    kb_head_queries = Column(Integer, nullable=False, default=0)
    active_kb_count = Column(Integer, nullable=False, default=0)
    active_user_count = Column(Integer, nullable=False, default=0)
    new_kb_count = Column(Integer, nullable=False, default=0)
    new_doc_count = Column(Integer, nullable=False, default=0)
    dingtalk_active_user_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_dashboard_date", "stat_date"),
        Index("idx_dashboard_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class KbDailyStats(StatBase):
    """Per-KB daily time-series for the KB-detail dashboard.

    Filling the DailyDashboardRow schema on the KB-detail page used to
    require assembling from kb_stat_rag_call_frequency +
    kb_stat_kb_head_frequency via UNION ALL, which left 7 of 11 fields
    hard-coded to zero. This dedicated table stores the full per-KB
    daily breakdown so the KB-detail overview cards show real numbers.
    """

    __tablename__ = "kb_stat_kb_daily_stats"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=False)
    total_queries = Column(Integer, nullable=False, default=0)
    rag_queries = Column(Integer, nullable=False, default=0)
    head_queries = Column(Integer, nullable=False, default=0)
    direct_injection = Column(Integer, nullable=False, default=0)
    active_user_count = Column(Integer, nullable=False, default=0)
    new_doc_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("idx_kb_daily_stats_run", "run_id"),
        Index("idx_kb_daily_stats_kb_date", "kb_id", "stat_date"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
