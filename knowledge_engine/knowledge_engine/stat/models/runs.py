# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Run metadata tables for KB statistics collection."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Index, Integer, String, Text
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class Run(StatBase):
    """Each collection execution creates one row here."""

    __tablename__ = "kb_stat_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime, nullable=False, default=func.now())
    completed_at = Column(DateTime, nullable=True)
    status = Column(
        String(20), nullable=False, default="running"
    )  # running / completed / failed / partial
    target_date = Column(Date, nullable=False)  # logical date of this collection
    kb_filter = Column(JSON, nullable=True)  # list of KB ids, null = full scan
    triggered_by = Column(
        String(32), nullable=False, default="beat"
    )  # beat / manual_cli / manual_api / retry
    triggered_user_id = Column(Integer, nullable=True)
    error_message = Column(Text, nullable=True)
    metrics_count = Column(Integer, nullable=False, default=0)
    stat_start = Column(Date, nullable=True, comment="Data range start")
    stat_end = Column(Date, nullable=True, comment="Data range end")

    __table_args__ = (
        Index("idx_runs_target_date", "target_date", "status"),
        Index("idx_runs_started_at", "started_at"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class CollectorRun(StatBase):
    """Per-collector execution record for fine-grained debugging."""

    __tablename__ = "kb_stat_collector_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(Integer, nullable=False, index=True)
    domain = Column(String(64), nullable=False)
    collector_name = Column(String(128), nullable=False)
    status = Column(
        String(20), nullable=False, default="running"
    )  # running / success / failed / skipped
    started_at = Column(DateTime, nullable=False, default=func.now())
    completed_at = Column(DateTime, nullable=True)
    rows_written = Column(Integer, nullable=False, default=0)
    duration_ms = Column(BigInteger, nullable=False, default=0)
    error_message = Column(Text, nullable=True)

    __table_args__ = (
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
