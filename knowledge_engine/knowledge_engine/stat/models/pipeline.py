# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Statistics-only staging, watermark, and pipeline observability models."""

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Date,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)

from knowledge_engine.stat.models.base import StatBase

_TABLE_OPTIONS = {
    "mysql_engine": "InnoDB",
    "mysql_charset": "utf8mb4",
    "mysql_collate": "utf8mb4_unicode_ci",
}


class ExtractorRun(StatBase):
    """One source extraction attempt within a statistics run."""

    __tablename__ = "kb_stat_extractor_runs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    extractor_name = Column(String(128), nullable=False)
    status = Column(String(20), nullable=False)
    source_cutoff = Column(String(255), nullable=True)
    started_at = Column(DateTime, nullable=False, default=func.now())
    completed_at = Column(DateTime, nullable=True)
    rows_read = Column(BigInteger, nullable=False, default=0)
    rows_written = Column(BigInteger, nullable=False, default=0)
    batches = Column(Integer, nullable=False, default=0)
    duration_ms = Column(BigInteger, nullable=False, default=0)
    error_message = Column(Text, nullable=True)

    __table_args__ = (
        UniqueConstraint("run_id", "extractor_name", name="uq_kb_stat_extractor_run"),
        Index("ix_kb_stat_extractor_status", "status", "started_at"),
        _TABLE_OPTIONS,
    )


class StageQueryEvent(StatBase):
    """Narrow, parsed query event stored only in the statistics database."""

    __tablename__ = "kb_stat_stage_query_event"

    run_id = Column(BigInteger, primary_key=True)
    event_id = Column(BigInteger, primary_key=True)
    event_time = Column(DateTime, nullable=False)
    stat_date = Column(Date, nullable=False)
    kb_id = Column(BigInteger, nullable=True)
    user_id = Column(BigInteger, nullable=True)
    injection_mode = Column(String(32), nullable=True)
    is_rag = Column(Boolean, nullable=False, default=False)
    is_kb_head = Column(Boolean, nullable=False, default=False)
    chunks_count = Column(Integer, nullable=True)
    retrieval_count = Column(Integer, nullable=True)
    restricted_mode = Column(Boolean, nullable=True)
    hit = Column(Boolean, nullable=True)
    adopted = Column(Boolean, nullable=True)
    cited_count = Column(Integer, nullable=True)
    query_hash = Column(String(64), nullable=True)
    duration_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("ix_stage_query_kb_date", "run_id", "kb_id", "stat_date"),
        Index("ix_stage_query_date_mode", "run_id", "stat_date", "injection_mode"),
        Index("ix_stage_query_user_date", "run_id", "user_id", "stat_date"),
        _TABLE_OPTIONS,
    )


class SourceWatermark(StatBase):
    """Last atomically published cursor for one source extractor."""

    __tablename__ = "kb_stat_source_watermarks"

    source_name = Column(String(128), primary_key=True)
    partition_key = Column(String(255), primary_key=True, default="global")
    last_source_id = Column(BigInteger, nullable=True)
    last_event_time = Column(DateTime, nullable=True)
    last_successful_run_id = Column(BigInteger, nullable=True)
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (_TABLE_OPTIONS,)


class MetricWatermark(StatBase):
    """Published data version for a metric and scope."""

    __tablename__ = "kb_stat_metric_watermarks"

    metric_name = Column(String(128), primary_key=True)
    scope_key = Column(String(255), primary_key=True, default="admin")
    run_id = Column(BigInteger, nullable=False)
    stat_date = Column(Date, nullable=False)
    status = Column(String(20), nullable=False, default="published")
    published_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        Index("ix_metric_watermark_run", "run_id"),
        _TABLE_OPTIONS,
    )
