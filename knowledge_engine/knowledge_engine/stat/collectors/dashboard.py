# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Dashboard domain collectors: global_totals + period_and_daily (merged)."""

import logging
from datetime import timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector
from knowledge_engine.stat.source import (
    DIRECT_INJECTION_SQL,
    KB_HEAD_SQL,
    RAG_RETRIEVAL_SQL,
)

logger = logging.getLogger(__name__)


@register_collector(
    domain="dashboard",
    name="global_totals",
    description="Global snapshot of KB/document/dingtalk counts",
    chart_hint="cards",
)
def collect_global_totals(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_count = (
        source_session.execute(
            text(
                "SELECT COUNT(*) AS cnt FROM kinds "
                "WHERE kind = 'KnowledgeBase' AND is_active = 1"
            )
        ).scalar()
        or 0
    )

    doc_count = (
        source_session.execute(
            text("SELECT COUNT(*) AS cnt FROM knowledge_documents WHERE is_active = 1")
        ).scalar()
        or 0
    )

    dingtalk_row = source_session.execute(
        text(
            """
            SELECT COUNT(DISTINCT user_id) AS user_cnt,
                   COUNT(DISTINCT dingtalk_node_id) AS node_cnt,
                   COUNT(*) AS doc_cnt
            FROM dingtalk_synced_nodes
            WHERE is_active = 1
        """
        )
    ).fetchone()

    stat_session.execute(
        text(
            """
            INSERT INTO kb_stat_global_totals
                (run_id, target_date, total_kb_count, total_doc_count,
                 dingtalk_synced_user_count, dingtalk_kb_count, dingtalk_doc_count)
            VALUES (:run_id, :target_date, :kb_count, :doc_count,
                    :dt_user, :dt_kb, :dt_doc)
        """
        ),
        {
            "run_id": run_id,
            "target_date": mfilter.target_date,
            "kb_count": kb_count,
            "doc_count": doc_count,
            "dt_user": dingtalk_row.user_cnt if dingtalk_row else 0,
            "dt_kb": dingtalk_row.node_cnt if dingtalk_row else 0,
            "dt_doc": dingtalk_row.doc_cnt if dingtalk_row else 0,
        },
    )
    return 1


@register_collector(
    domain="dashboard",
    name="period_and_daily",
    description="Period cumulative totals + daily detail rows (merged collection)",
    chart_hint="cards+table",
)
def collect_period_and_daily(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    start = mfilter.effective_period_start
    end = mfilter.effective_end_date

    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_join = ""
    if kb_clause:
        kb_join = (
            " AND JSON_EXTRACT(sc.type_data, '$.knowledge_id') IN "
            + kb_clause.replace("kb_", "kbf_")
        )
        kb_params = {k.replace("kb_", "kbf_"): v for k, v in kb_params.items()}

    # --- Period totals ---
    period_row = source_session.execute(
        text(
            f"""
            SELECT
                COUNT(*) AS total_queries,
                SUM(CASE WHEN {RAG_RETRIEVAL_SQL} THEN 1 ELSE 0 END) AS rag_queries,
                SUM(CASE WHEN {DIRECT_INJECTION_SQL} THEN 1 ELSE 0 END) AS direct_inject,
                SUM(CASE WHEN {KB_HEAD_SQL} THEN 1 ELSE 0 END) AS kb_head_queries
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= :start_date
              AND sc.created_at <= :end_date
              {kb_join}
        """
        ),
        {"start_date": start, "end_date": end, **kb_params},
    ).fetchone()

    period_new_kb = (
        source_session.execute(
            text(
                f"""
            SELECT COUNT(*) AS cnt FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              AND created_at >= :start_date AND created_at <= :end_date
              {"AND id " + kb_clause if kb_clause else ""}
        """
            ),
            {"start_date": start, "end_date": end, **kb_params},
        ).scalar()
        or 0
    )

    period_new_docs = (
        source_session.execute(
            text(
                f"""
            SELECT COUNT(*) AS cnt FROM knowledge_documents
            WHERE created_at >= :start_date AND created_at <= :end_date
            {"AND kind_id " + kb_clause if kb_clause else ""}
        """
            ),
            {"start_date": start, "end_date": end, **kb_params},
        ).scalar()
        or 0
    )

    stat_session.execute(
        text(
            """
            INSERT INTO kb_stat_period_totals
                (run_id, target_date, start_date, end_date,
                 period_total_queries, period_new_kb, period_new_docs,
                 period_rag_queries, period_direct_inject, period_kb_head_queries)
            VALUES (:run_id, :target_date, :start_date, :end_date,
                    :total_queries, :new_kb, :new_docs,
                    :rag_queries, :direct_inject, :kb_head_queries)
        """
        ),
        {
            "run_id": run_id,
            "target_date": mfilter.target_date,
            "start_date": start,
            "end_date": end,
            "total_queries": period_row.total_queries if period_row else 0,
            "new_kb": period_new_kb,
            "new_docs": period_new_docs,
            "rag_queries": period_row.rag_queries if period_row else 0,
            "direct_inject": period_row.direct_inject if period_row else 0,
            "kb_head_queries": period_row.kb_head_queries if period_row else 0,
        },
    )

    # --- Daily dashboard rows ---
    daily_rows = source_session.execute(
        text(
            f"""
            SELECT
                DATE(sc.created_at) AS d,
                COUNT(*) AS total_queries,
                SUM(CASE WHEN {RAG_RETRIEVAL_SQL} THEN 1 ELSE 0 END) AS rag_queries,
                SUM(CASE WHEN {DIRECT_INJECTION_SQL} THEN 1 ELSE 0 END) AS direct_injection,
                SUM(CASE WHEN {RAG_RETRIEVAL_SQL} AND {KB_HEAD_SQL} THEN 1 ELSE 0 END)
                    AS kb_head_rag_queries,
                SUM(CASE WHEN {KB_HEAD_SQL} THEN 1 ELSE 0 END) AS kb_head_queries,
                COUNT(DISTINCT JSON_EXTRACT(sc.type_data, '$.knowledge_id')) AS active_kb_count,
                COUNT(DISTINCT sc.user_id) AS active_user_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= :start_date
              AND sc.created_at <= :end_date
              {kb_join}
            GROUP BY DATE(sc.created_at)
            ORDER BY d
        """
        ),
        {"start_date": start, "end_date": end, **kb_params},
    ).fetchall()

    written = 1  # period_totals already written

    # Pre-fetch new_kb and new_doc per day
    new_kb_by_day = {}
    new_kb_rows = source_session.execute(
        text(
            f"""
            SELECT DATE(created_at) AS d, COUNT(*) AS cnt
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              AND created_at >= :start_date AND created_at <= :end_date
              {"AND id " + kb_clause if kb_clause else ""}
            GROUP BY DATE(created_at)
        """
        ),
        {"start_date": start, "end_date": end, **kb_params},
    ).fetchall()
    for r in new_kb_rows:
        new_kb_by_day[r.d] = r.cnt

    new_doc_by_day = {}
    new_doc_rows = source_session.execute(
        text(
            """
            SELECT DATE(created_at) AS d, COUNT(*) AS cnt
            FROM knowledge_documents
            WHERE created_at >= :start_date AND created_at <= :end_date
            GROUP BY DATE(created_at)
        """
        ),
        {"start_date": start, "end_date": end},
    ).fetchall()
    for r in new_doc_rows:
        new_doc_by_day[r.d] = r.cnt

    # Dingtalk daily active users
    dt_by_day = {}
    dt_rows = source_session.execute(
        text(
            """
            SELECT DATE(updated_at) AS d, COUNT(DISTINCT user_id) AS cnt
            FROM dingtalk_synced_nodes
            WHERE updated_at >= :start_date AND updated_at <= :end_date
            GROUP BY DATE(updated_at)
        """
        ),
        {"start_date": start, "end_date": end},
    ).fetchall()
    for r in dt_rows:
        dt_by_day[r.d] = r.cnt

    for r in daily_rows:
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_daily_dashboard
                    (run_id, target_date, stat_date,
                     total_queries, rag_queries, direct_injection,
                     kb_head_rag_queries, kb_head_queries,
                     active_kb_count, active_user_count,
                     new_kb_count, new_doc_count, dingtalk_active_user_count)
                VALUES (:run_id, :target_date, :stat_date,
                        :total_queries, :rag_queries, :direct_injection,
                        :kb_head_rag_queries, :kb_head_queries,
                        :active_kb_count, :active_user_count,
                        :new_kb_count, :new_doc_count, :dt_active_user)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "total_queries": r.total_queries,
                "rag_queries": r.rag_queries,
                "direct_injection": r.direct_injection,
                "kb_head_rag_queries": r.kb_head_rag_queries,
                "kb_head_queries": r.kb_head_queries,
                "active_kb_count": r.active_kb_count,
                "active_user_count": r.active_user_count,
                "new_kb_count": new_kb_by_day.get(r.d, 0),
                "new_doc_count": new_doc_by_day.get(r.d, 0),
                "dt_active_user": dt_by_day.get(r.d, 0),
            },
        )
        written += 1

    return written


@register_collector(
    domain="dashboard",
    name="kb_daily_stats",
    description=(
        "Per-KB daily time-series (rag/head/direct counts, active users, "
        "new docs) backing the KB-detail dashboard overview cards"
    ),
    chart_hint="line",
    # Internal collector: not queryable as a standalone metric. Its rows
    # are consumed by _fetch_kb_daily_rows to fill the DailyDashboardRow
    # schema for KB-scoped dashboard queries.
    enabled=True,
)
def collect_kb_daily_stats(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB daily breakdown for the KB-detail dashboard.

    The global daily_dashboard collector only stores platform-wide daily
    rows. On the KB-detail page we need the same daily shape scoped to a
    single KB, including fields the UNION-ALL fallback couldn't supply
    (direct_injection, active_user_count, new_doc_count). This collector
    writes one row per (kb_id, stat_date) so the query service can read a
    complete daily series without zero-filling.
    """
    start = mfilter.effective_period_start
    end = mfilter.effective_end_date
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    # When no KB filter is supplied we still write rows for every KB that
    # saw activity in the window, so admins can later drill into any KB.
    kb_join = ""
    if kb_clause:
        kb_join = (
            " AND JSON_EXTRACT(sc.type_data, '$.knowledge_id') IN "
            + kb_clause.replace("kb_", "kbf_")
        )
        kb_params = {k.replace("kb_", "kbf_"): v for k, v in kb_params.items()}

    # Per-KB daily query breakdown from subtask_contexts. One row per
    # (kb_id, stat_date) with rag / direct / head / active-user counts.
    daily_rows = source_session.execute(
        text(
            f"""
            SELECT
                DATE(sc.created_at) AS d,
                CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                COUNT(*) AS total_queries,
                SUM(CASE WHEN {RAG_RETRIEVAL_SQL} THEN 1 ELSE 0 END) AS rag_queries,
                SUM(CASE WHEN {DIRECT_INJECTION_SQL} THEN 1 ELSE 0 END) AS direct_inject,
                SUM(CASE WHEN {KB_HEAD_SQL} THEN 1 ELSE 0 END) AS head_queries,
                COUNT(DISTINCT sc.user_id) AS active_user_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.knowledge_id') IS NOT NULL
              AND sc.created_at >= :start_date
              AND sc.created_at <= :end_date
              {kb_join}
            GROUP BY DATE(sc.created_at),
                     CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED)
        """
        ),
        {"start_date": start, "end_date": end, **kb_params},
    ).fetchall()

    if not daily_rows:
        return 0

    # Pre-fetch new docs per (kb_id, day) from knowledge_documents.
    new_doc_by_kb_day: dict[tuple, int] = {}
    new_doc_rows = source_session.execute(
        text(
            f"""
            SELECT DATE(created_at) AS d, kind_id AS kb_id, COUNT(*) AS cnt
            FROM knowledge_documents
            WHERE is_active = 1
              AND created_at >= :start_date AND created_at <= :end_date
              {"AND kind_id " + kb_clause if kb_clause else ""}
            GROUP BY DATE(created_at), kind_id
        """
        ),
        {"start_date": start, "end_date": end, **kb_params},
    ).fetchall()
    for r in new_doc_rows:
        new_doc_by_kb_day[(r.kb_id, r.d)] = r.cnt

    written = 0
    for r in daily_rows:
        kb_id = int(r.kb_id or 0)
        if kb_id == 0:
            continue  # rows without knowledge_id are useless for KB-detail
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_daily_stats
                    (run_id, target_date, stat_date, kb_id,
                     rag_queries, head_queries, direct_injection,
                     active_user_count, new_doc_count)
                VALUES (:run_id, :target_date, :stat_date, :kb_id,
                        :rag_queries, :head_queries, :direct_injection,
                        :active_user_count, :new_doc_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": kb_id,
                "rag_queries": int(r.rag_queries or 0),
                "head_queries": int(r.head_queries or 0),
                "direct_injection": int(r.direct_inject or 0),
                "active_user_count": int(r.active_user_count or 0),
                "new_doc_count": new_doc_by_kb_day.get((kb_id, r.d), 0),
            },
        )
        written += 1

    return written
