# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prometheus domain collectors (DB-fallback, no Prometheus server required)."""

import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector

logger = logging.getLogger(__name__)


@register_collector(
    domain="prometheus",
    name="prom_conversion_success_rate",
    description="Document conversion success rate by file type",
    chart_hint="cards",
)
def prom_conversion_success_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect document conversion success rate grouped by file extension."""
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT file_extension,
                   COUNT(*) AS total,
                   SUM(CASE WHEN index_status = 'success' THEN 1 ELSE 0 END) AS success_cnt,
                   ROUND(
                       SUM(CASE WHEN index_status = 'success' THEN 1 ELSE 0 END)
                       / COUNT(*) * 100, 2
                   ) AS success_rate
            FROM knowledge_documents
            WHERE is_active = 1
              {kb_where}
            GROUP BY file_extension
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_prom_conversion_success_rate
                    (run_id, target_date, file_extension, success_rate,
                     total_count, success_count)
                VALUES (:run_id, :target_date, :file_extension, :success_rate,
                        :total_count, :success_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "file_extension": r.file_extension,
                "success_rate": r.success_rate,
                "total_count": r.total,
                "success_count": r.success_cnt,
            },
        )
        written += 1
    return written


@register_collector(
    domain="prometheus",
    name="prom_conversion_duration",
    description="Document conversion duration P50/P90/P99 (estimated)",
    chart_hint="cards",
)
def prom_conversion_duration(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect conversion duration percentiles by file extension.

    NOTE: the Prometheus data source (and the DB fallback here) only exposes
    the average per-document conversion time, not the raw per-record latency
    distribution. The p50/p90/p99 columns are therefore a HEURISTIC ESTIMATE
    derived from the mean (avg*0.8 / avg*1.5 / avg*2.5), NOT real quantiles.
    The schema labels carry an "(估算)" / "(estimated)" suffix to make this
    clear to the frontend; treat them as a rough long-tail indicator only.
    """
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT file_extension,
                   AVG(TIMESTAMPDIFF(SECOND, created_at, updated_at)) AS avg_seconds
            FROM knowledge_documents
            WHERE is_active = 1
              AND index_status = 'success'
              AND updated_at > created_at
              AND TIMESTAMPDIFF(SECOND, created_at, updated_at) < 3600
              {kb_where}
            GROUP BY file_extension
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        avg_s = float(r.avg_seconds) if r.avg_seconds else 0.0
        # Heuristic estimate from the mean — NOT real percentiles (see docstring).
        p50 = round(avg_s * 0.8, 2)
        p90 = round(avg_s * 1.5, 2)
        p99 = round(avg_s * 2.5, 2)

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_prom_conversion_duration
                    (run_id, target_date, file_extension,
                     p50_seconds, p90_seconds, p99_seconds)
                VALUES (:run_id, :target_date, :file_extension,
                        :p50_seconds, :p90_seconds, :p99_seconds)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "file_extension": r.file_extension,
                "p50_seconds": p50,
                "p90_seconds": p90,
                "p99_seconds": p99,
            },
        )
        written += 1
    return written


@register_collector(
    domain="prometheus",
    name="prom_active_conversions",
    description="Count documents currently in converting/indexing state",
    chart_hint="cards",
)
def prom_active_conversions(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect count of documents in active conversion states."""
    active_count = source_session.execute(text("""
            SELECT COUNT(*) AS active_count
            FROM knowledge_documents
            WHERE index_status IN ('converting', 'pending_conversion', 'indexing')
        """)).scalar() or 0

    stat_session.execute(
        text("""
            INSERT INTO kb_stat_prom_active_conversions
                (run_id, target_date, active_count)
            VALUES (:run_id, :target_date, :active_count)
        """),
        {
            "run_id": run_id,
            "target_date": mfilter.target_date,
            "active_count": active_count,
        },
    )
    return 1


@register_collector(
    domain="prometheus",
    name="prom_callback_success_rate",
    description="7-day callback success rate",
    chart_hint="cards",
)
def prom_callback_success_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect 7-day callback success rate based on document index status."""
    row = source_session.execute(
        text("""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN index_status IN ('converting', 'pending_conversion')
                       THEN 1 ELSE 0 END) AS stuck
            FROM knowledge_documents
            WHERE is_active = 1
              AND created_at >= DATE_SUB(:end_date, INTERVAL 7 DAY)
        """),
        {"end_date": mfilter.effective_end_date},
    ).fetchone()

    total = int(row.total) if row and row.total else 0
    stuck = int(row.stuck) if row and row.stuck else 0
    success = total - stuck
    success_rate = round(success / total * 100, 2) if total > 0 else 0.0

    stat_session.execute(
        text("""
            INSERT INTO kb_stat_prom_callback_success_rate
                (run_id, target_date, callback_type,
                 total_count, success_count, success_rate)
            VALUES (:run_id, :target_date, :callback_type,
                    :total_count, :success_count, :success_rate)
        """),
        {
            "run_id": run_id,
            "target_date": mfilter.target_date,
            "callback_type": "conversion_callback",
            "total_count": total,
            "success_count": success,
            "success_rate": success_rate,
        },
    )
    return 1
