# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prometheus metric tables (conversion success, duration, active, callback)."""

from sqlalchemy import BigInteger, Column, Date, DateTime, Float, Index, Integer, String
from sqlalchemy.sql import func

from knowledge_engine.stat.models.base import StatBase


class PromConversionSuccessRate(StatBase):
    """Prometheus conversion success rate by file extension (cross-section)."""

    __tablename__ = "kb_stat_prom_conversion_success_rate"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    file_extension = Column(String(64), nullable=True)
    success_rate = Column(Float, nullable=True)
    total_count = Column(Integer, default=0)
    success_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_prom_conv_rate_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class PromConversionDuration(StatBase):
    """Prometheus conversion duration percentiles by file extension (cross-section)."""

    __tablename__ = "kb_stat_prom_conversion_duration"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    file_extension = Column(String(64), nullable=True)
    p50_seconds = Column(Float, nullable=True)
    p90_seconds = Column(Float, nullable=True)
    p99_seconds = Column(Float, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_prom_conv_dur_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class PromActiveConversions(StatBase):
    """Prometheus active conversion count snapshot (cross-section)."""

    __tablename__ = "kb_stat_prom_active_conversions"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    active_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_prom_active_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class PromCallbackSuccessRate(StatBase):
    """Prometheus callback success rate by callback type (cross-section)."""

    __tablename__ = "kb_stat_prom_callback_success_rate"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    run_id = Column(BigInteger, nullable=False)
    target_date = Column(Date, nullable=False)
    callback_type = Column(String(64), nullable=True)
    total_count = Column(Integer, default=0)
    success_count = Column(Integer, default=0)
    success_rate = Column(Float, nullable=True)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("idx_prom_callback_run", "run_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
