# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Retrieval domain collectors: RAG/head call frequency, document references,
injection mode distribution, restricted mode usage, call limits,
selected documents behavior, query analysis, and chunk count distribution."""

import json
import logging
from collections import defaultdict

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector
from knowledge_engine.stat.source import (
    KB_HEAD_SQL,
    RAG_RETRIEVAL_SQL,
    fetch_kb_metadata,
)

logger = logging.getLogger(__name__)

# Below this many queries in the lookback window, per-KB ratio metrics
# (zero_chunk_rate, hit_rate, etc.) become statistically meaningless — a
# single hit/miss swings the rate by 50-100%. The collector marks such
# rows with low_confidence=1 so the frontend can grey out the point and
# avoid drawing a misleading spike.
LOW_CONFIDENCE_THRESHOLD = 5

# A query is "slow" when its RAG latency exceeds this fixed wall-clock
# threshold (milliseconds). We deliberately avoid a self-referential
# percentile (e.g. "above this KB's own P95") because that definition is
# meaningless on small samples — with total<21 the P95 index falls outside
# the array and ~every query ends up "not slow". A constant 2s cutoff is
# independent of sample size and matches the SLO expectation users have.
SLOW_LATENCY_MS = 2000

# ---------------------------------------------------------------------------
# Chunk count distribution buckets
# ---------------------------------------------------------------------------
_CHUNK_BUCKETS = [
    ("0", lambda c: c == 0),
    ("1", lambda c: c == 1),
    ("2-3", lambda c: 2 <= c <= 3),
    ("4-5", lambda c: 4 <= c <= 5),
    ("6-10", lambda c: 6 <= c <= 10),
    (">10", lambda c: c > 10),
]


def _classify_chunks(count: int) -> str:
    """Return the bucket label for a given chunk count."""
    for label, predicate in _CHUNK_BUCKETS:
        if predicate(count):
            return label
    return "0"


# ---------------------------------------------------------------------------
# Helper: build KB filter for subtask_contexts JSON knowledge_id
# ---------------------------------------------------------------------------
def _kb_json_filter(mfilter: MetricFilter, prefix: str = "kbf") -> tuple[str, dict]:
    """Return (sql_fragment, params) for KB id filtering via JSON_EXTRACT on type_data."""
    if not mfilter.kb_ids:
        return "", {}
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids, prefix=prefix)
    sql = f"AND JSON_EXTRACT(sc.type_data, '$.knowledge_id') {kb_clause}"
    return sql, kb_params


# ---------------------------------------------------------------------------
# 1. rag_call_frequency
# ---------------------------------------------------------------------------
@register_collector(
    domain="retrieval",
    name="rag_call_frequency",
    description="Daily RAG call frequency per KB",
    chart_hint="line",
)
def rag_call_frequency(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(sc.created_at) AS d,
                   CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   COUNT(*) AS call_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND {RAG_RETRIEVAL_SQL}
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(sc.created_at), kb_id
            ORDER BY d
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    # Fetch KB names for the involved kb_ids
    kb_ids_in_result = {r.kb_id for r in rows if r.kb_id}
    kb_meta = fetch_kb_metadata(
        source_session, list(kb_ids_in_result) if kb_ids_in_result else None
    )

    written = 0
    for r in rows:
        _, kb_name = kb_meta.get(r.kb_id, ("", ""))
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_rag_call_frequency
                    (run_id, target_date, stat_date, kb_id, kb_name, call_count)
                VALUES (:run_id, :target_date, :stat_date, :kb_id, :kb_name, :call_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": r.kb_id,
                "kb_name": kb_name,
                "call_count": r.call_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 2. kb_head_frequency
# ---------------------------------------------------------------------------
@register_collector(
    domain="retrieval",
    name="kb_head_frequency",
    description="Daily kb_head call frequency per KB",
    chart_hint="line",
)
def kb_head_frequency(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(sc.created_at) AS d,
                   CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   COUNT(*) AS call_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND {KB_HEAD_SQL}
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(sc.created_at), kb_id
            ORDER BY d
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    kb_ids_in_result = {r.kb_id for r in rows if r.kb_id}
    kb_meta = fetch_kb_metadata(
        source_session, list(kb_ids_in_result) if kb_ids_in_result else None
    )

    written = 0
    for r in rows:
        _, kb_name = kb_meta.get(r.kb_id, ("", ""))
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_head_frequency
                    (run_id, target_date, stat_date, kb_id, kb_name, call_count)
                VALUES (:run_id, :target_date, :stat_date, :kb_id, :kb_name, :call_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": r.kb_id,
                "kb_name": kb_name,
                "call_count": r.call_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 3. rag_vs_head_ratio
# ---------------------------------------------------------------------------
@register_collector(
    domain="retrieval",
    name="rag_vs_head_ratio",
    description="Daily RAG vs head injection ratio",
    chart_hint="line",
)
def rag_vs_head_ratio(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(sc.created_at) AS d,
                   SUM(CASE WHEN {RAG_RETRIEVAL_SQL} THEN 1 ELSE 0 END) AS rag_count,
                   SUM(CASE WHEN {KB_HEAD_SQL} THEN 1 ELSE 0 END) AS head_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(sc.created_at)
            ORDER BY d
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        rag = int(r.rag_count or 0)
        head = int(r.head_count or 0)
        total = rag + head
        rag_ratio = round(rag / total * 100, 2) if total > 0 else None

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_rag_vs_head_ratio
                    (run_id, target_date, stat_date, rag_count, head_count, rag_ratio)
                VALUES (:run_id, :target_date, :stat_date, :rag_count, :head_count, :rag_ratio)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "rag_count": rag,
                "head_count": head,
                "rag_ratio": rag_ratio,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 4. doc_reference_count
# ---------------------------------------------------------------------------
@register_collector(
    domain="retrieval",
    name="doc_reference_count",
    description="Top 200 docs by RAG+head references",
    chart_hint="table",
)
def doc_reference_count(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT sc.type_data
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    # Parse type_data and aggregate per document
    # doc_id -> (kb_id, rag_count, head_count)
    doc_stats: dict[int, tuple[int, int, int]] = {}

    for r in rows:
        try:
            data = json.loads(r.type_data) if r.type_data else {}
        except (json.JSONDecodeError, TypeError):
            continue

        kb_id = data.get("knowledge_id")
        if kb_id is not None:
            try:
                kb_id = int(kb_id)
            except (ValueError, TypeError):
                kb_id = None

        # RAG references from rag_result.sources
        rag_result = data.get("rag_result")
        if rag_result and isinstance(rag_result, dict):
            sources = rag_result.get("sources", [])
            if isinstance(sources, list):
                for src in sources:
                    doc_id = src.get("document_id") or src.get("doc_id")
                    if doc_id is not None:
                        try:
                            doc_id = int(doc_id)
                        except (ValueError, TypeError):
                            continue
                        if doc_id not in doc_stats:
                            doc_stats[doc_id] = (kb_id or 0, 0, 0)
                        existing = doc_stats[doc_id]
                        doc_stats[doc_id] = (existing[0], existing[1] + 1, existing[2])

        # HEAD references from kb_head_result.document_ids
        head_result = data.get("kb_head_result")
        if head_result and isinstance(head_result, dict):
            doc_ids = head_result.get("document_ids", [])
            if isinstance(doc_ids, list):
                for doc_id in doc_ids:
                    try:
                        doc_id = int(doc_id)
                    except (ValueError, TypeError):
                        continue
                    if doc_id not in doc_stats:
                        doc_stats[doc_id] = (kb_id or 0, 0, 0)
                    existing = doc_stats[doc_id]
                    doc_stats[doc_id] = (existing[0], existing[1], existing[2] + 1)

    # Sort by total reference count descending, take top 200
    sorted_docs = sorted(
        doc_stats.items(),
        key=lambda x: x[1][1] + x[1][2],
        reverse=True,
    )[:200]

    if not sorted_docs:
        return 0

    # Fetch document names
    doc_ids = [d[0] for d in sorted_docs]
    doc_id_clause, doc_id_params = build_kb_in_clause(doc_ids, prefix="did")
    doc_rows = source_session.execute(
        text(
            f"""
            SELECT id, name
            FROM knowledge_documents
            WHERE id {doc_id_clause}
        """
        ),
        doc_id_params,
    ).fetchall()
    doc_names = {r.id: r.name or "" for r in doc_rows}

    written = 0
    for doc_id, (kb_id, rag_ref, head_ref) in sorted_docs:
        total_ref = rag_ref + head_ref
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_doc_reference_count
                    (run_id, target_date, document_id, document_name,
                     kb_id, rag_ref_count, head_ref_count, total_ref_count)
                VALUES (:run_id, :target_date, :document_id, :document_name,
                        :kb_id, :rag_ref_count, :head_ref_count, :total_ref_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "document_id": doc_id,
                "document_name": doc_names.get(doc_id, ""),
                "kb_id": kb_id,
                "rag_ref_count": rag_ref,
                "head_ref_count": head_ref,
                "total_ref_count": total_ref,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 5. doc_read_count
# ---------------------------------------------------------------------------
@register_collector(
    domain="retrieval",
    name="doc_read_count",
    description="Top 200 docs by kb_head reads",
    chart_hint="table",
)
def doc_read_count(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT sc.type_data
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND {KB_HEAD_SQL}
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    # Parse type_data and aggregate head reads per document
    # doc_id -> (kb_id, read_count)
    doc_reads: dict[int, tuple[int, int]] = {}

    for r in rows:
        try:
            data = json.loads(r.type_data) if r.type_data else {}
        except (json.JSONDecodeError, TypeError):
            continue

        kb_id = data.get("knowledge_id")
        if kb_id is not None:
            try:
                kb_id = int(kb_id)
            except (ValueError, TypeError):
                kb_id = None

        head_result = data.get("kb_head_result")
        if head_result and isinstance(head_result, dict):
            doc_ids = head_result.get("document_ids", [])
            if isinstance(doc_ids, list):
                for doc_id in doc_ids:
                    try:
                        doc_id = int(doc_id)
                    except (ValueError, TypeError):
                        continue
                    if doc_id not in doc_reads:
                        doc_reads[doc_id] = (kb_id or 0, 0)
                    existing = doc_reads[doc_id]
                    doc_reads[doc_id] = (existing[0], existing[1] + 1)

    # Sort by read count descending, take top 200
    sorted_docs = sorted(
        doc_reads.items(),
        key=lambda x: x[1][1],
        reverse=True,
    )[:200]

    if not sorted_docs:
        return 0

    # Fetch document names
    doc_ids = [d[0] for d in sorted_docs]
    doc_id_clause, doc_id_params = build_kb_in_clause(doc_ids, prefix="did")
    doc_rows = source_session.execute(
        text(
            f"""
            SELECT id, name
            FROM knowledge_documents
            WHERE id {doc_id_clause}
        """
        ),
        doc_id_params,
    ).fetchall()
    doc_names = {r.id: r.name or "" for r in doc_rows}

    written = 0
    for doc_id, (kb_id, read_count) in sorted_docs:
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_doc_read_count
                    (run_id, target_date, document_id, document_name, kb_id, read_count)
                VALUES (:run_id, :target_date, :document_id, :document_name, :kb_id, :read_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "document_id": doc_id,
                "document_name": doc_names.get(doc_id, ""),
                "kb_id": kb_id,
                "read_count": read_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 6. retrieval_mode_distribution
# ---------------------------------------------------------------------------
@register_collector(
    domain="retrieval",
    name="retrieval_mode_distribution",
    description="Injection mode distribution across all RAG calls",
    chart_hint="pie",
)
def retrieval_mode_distribution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)
    rows = source_session.execute(
        text(
            f"""
            SELECT JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.rag_result.injection_mode')) AS mode,
                   COUNT(*) AS call_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.rag_result') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY mode
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        mode = r.mode or "unknown"
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_retrieval_mode_distribution
                    (run_id, target_date, injection_mode, call_count)
                VALUES (:run_id, :target_date, :injection_mode, :call_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "injection_mode": mode,
                "call_count": r.call_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 7. restricted_mode_usage
# ---------------------------------------------------------------------------
@register_collector(
    domain="retrieval",
    name="restricted_mode_usage",
    description="Per-KB restricted mode rate",
    chart_hint="table",
)
def restricted_mode_usage(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   COUNT(*) AS total_calls,
                   SUM(CASE WHEN JSON_EXTRACT(sc.type_data, '$.rag_result.restricted_mode') = TRUE
                        THEN 1 ELSE 0 END) AS restricted_calls
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.rag_result') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY kb_id
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        total = int(r.total_calls or 0)
        restricted = int(r.restricted_calls or 0)
        restricted_rate = round(restricted / total * 100, 2) if total > 0 else None

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_restricted_mode_usage
                    (run_id, target_date, kb_id, total_calls, restricted_calls, restricted_rate)
                VALUES (:run_id, :target_date, :kb_id, :total_calls, :restricted_calls, :restricted_rate)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "total_calls": total,
                "restricted_calls": restricted,
                "restricted_rate": restricted_rate,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 8. rag_call_limit
# ---------------------------------------------------------------------------
@register_collector(
    domain="retrieval",
    name="rag_call_limit",
    description="Per-KB hit-limit count based on maxCallsPerConversation config",
    chart_hint="table",
)
def rag_call_limit(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    # Step 1: Fetch KB configs with maxCallsPerConversation from kinds.json
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND id {kb_clause}" if kb_clause else ""

    kb_rows = source_session.execute(
        text(
            f"""
            SELECT id,
                   JSON_EXTRACT(json, '$.spec.maxCallsPerConversation') AS max_calls
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_where}
        """
        ),
        kb_params,
    ).fetchall()

    # Build kb_id -> max_calls mapping (default 10 if not configured)
    kb_max_calls: dict[int, int] = {}
    for r in kb_rows:
        max_calls = r.max_calls
        if max_calls is not None:
            try:
                max_calls = int(max_calls)
            except (ValueError, TypeError):
                max_calls = 10
        else:
            max_calls = 10
        kb_max_calls[r.id] = max_calls

    if not kb_max_calls:
        return 0

    # Step 2: Fetch subtask_contexts and count retrieval_count per kb_id
    kb_ids = list(kb_max_calls.keys())
    kb_id_clause, kb_id_params = build_kb_in_clause(kb_ids, prefix="lkbf")
    kb_filter_sql = f"AND JSON_EXTRACT(sc.type_data, '$.knowledge_id') {kb_id_clause}"

    ctx_rows = source_session.execute(
        text(
            f"""
            SELECT CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   CAST(JSON_EXTRACT(sc.type_data, '$.rag_result.retrieval_count') AS SIGNED)
                       AS retrieval_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.rag_result') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_id_params,
        },
    ).fetchall()

    # Step 3: Count how many times retrieval_count >= max_calls per kb_id
    hit_limit_counts: dict[int, int] = defaultdict(int)
    for r in ctx_rows:
        max_calls = kb_max_calls.get(r.kb_id, 10)
        if r.retrieval_count is not None and r.retrieval_count >= max_calls:
            hit_limit_counts[r.kb_id] += 1

    written = 0
    for kb_id, max_calls in kb_max_calls.items():
        hit_count = hit_limit_counts.get(kb_id, 0)
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_rag_call_limit
                    (run_id, target_date, kb_id, max_calls_config, hit_limit_count)
                VALUES (:run_id, :target_date, :kb_id, :max_calls_config, :hit_limit_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": kb_id,
                "max_calls_config": max_calls,
                "hit_limit_count": hit_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 9. selected_documents_usage
# ---------------------------------------------------------------------------
@register_collector(
    domain="retrieval",
    name="selected_documents_usage",
    description="Selected documents behavior (top 200)",
    chart_hint="table",
)
def selected_documents_usage(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    rows = source_session.execute(
        text(
            """
            SELECT sc.type_data
            FROM subtask_contexts sc
            WHERE sc.context_type = 'selected_documents'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
        },
    ).fetchall()

    # Parse type_data for knowledge_base_id and document_ids
    # (kb_id, doc_id) -> select_count
    doc_selects: dict[tuple[int, int], int] = defaultdict(int)

    for r in rows:
        try:
            data = json.loads(r.type_data) if r.type_data else {}
        except (json.JSONDecodeError, TypeError):
            continue

        kb_id = data.get("knowledge_base_id")
        if kb_id is not None:
            try:
                kb_id = int(kb_id)
            except (ValueError, TypeError):
                continue

        doc_ids = data.get("document_ids", [])
        if isinstance(doc_ids, list):
            for doc_id in doc_ids:
                try:
                    doc_id = int(doc_id)
                except (ValueError, TypeError):
                    continue
                doc_selects[(kb_id, doc_id)] += 1

    # Apply KB filter if specified
    if mfilter.kb_ids:
        kb_id_set = set(mfilter.kb_ids)
        doc_selects = {k: v for k, v in doc_selects.items() if k[0] in kb_id_set}

    # Sort by select count descending, take top 200
    sorted_docs = sorted(
        doc_selects.items(),
        key=lambda x: x[1],
        reverse=True,
    )[:200]

    written = 0
    for (kb_id, doc_id), select_count in sorted_docs:
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_selected_documents_usage
                    (run_id, target_date, kb_id, document_id, select_count)
                VALUES (:run_id, :target_date, :kb_id, :document_id, :select_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": kb_id,
                "document_id": doc_id,
                "select_count": select_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# Returned chunks-count distribution
# ---------------------------------------------------------------------------


@register_collector(
    domain="retrieval",
    name="chunks_count_distribution",
    description="Distribution of returned chunk counts per RAG retrieval",
    chart_hint="pie",
)
def chunks_count_distribution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect platform-level buckets for chunks returned by each RAG call."""
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)
    rows = source_session.execute(
        text(
            f"""
            SELECT
                CASE
                    WHEN chunks_count = 0 THEN '0'
                    WHEN chunks_count BETWEEN 1 AND 3 THEN '1-3'
                    WHEN chunks_count BETWEEN 4 AND 5 THEN '4-5'
                    WHEN chunks_count BETWEEN 6 AND 10 THEN '6-10'
                    ELSE '>10'
                END AS chunk_bucket,
                COUNT(*) AS call_count
            FROM (
                SELECT
                    CAST(
                        JSON_EXTRACT(
                            sc.type_data, '$.rag_result.chunks_count'
                        ) AS SIGNED
                    ) AS chunks_count
                FROM subtask_contexts sc
                WHERE sc.context_type = 'knowledge_base'
                  AND sc.created_at >= :start_date
                  AND sc.created_at < :end_date
                  AND JSON_EXTRACT(
                      sc.type_data, '$.rag_result.chunks_count'
                  ) IS NOT NULL
                  {kb_filter_sql}
            ) events
            GROUP BY chunk_bucket
        """
        ),
        {
            "start_date": mfilter.effective_period_start,
            "end_date": mfilter.effective_end_date,
            **kb_params,
        },
    ).fetchall()

    for row in rows:
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_chunks_count_distribution
                    (run_id, target_date, chunk_bucket, call_count)
                VALUES
                    (:run_id, :target_date, :chunk_bucket, :call_count)
                """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.period_end_date,
                "chunk_bucket": row.chunk_bucket,
                "call_count": int(row.call_count or 0),
            },
        )
    return len(rows)


# ---------------------------------------------------------------------------
# Per-KB collectors for KB detail page
# ---------------------------------------------------------------------------


@register_collector(
    domain="retrieval",
    name="kb_active_users",
    description="Per-KB active users with RAG/head call counts",
    chart_hint="table",
)
def kb_active_users(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB active users by parsing subtask_contexts type_data."""
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   sc.user_id,
                   SUM(CASE WHEN {RAG_RETRIEVAL_SQL} THEN 1 ELSE 0 END) AS rag_count,
                   SUM(CASE WHEN {KB_HEAD_SQL} THEN 1 ELSE 0 END) AS head_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY kb_id, sc.user_id
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    if not rows:
        return 0

    # Fetch user names
    user_ids = {r.user_id for r in rows if r.user_id}
    user_names: dict[int, str] = {}
    if user_ids:
        try:
            uid_clause, uid_params = build_kb_in_clause(list(user_ids), prefix="un")
            u_rows = source_session.execute(
                text(f"SELECT id, user_name FROM users WHERE id {uid_clause}"),
                uid_params,
            ).fetchall()
            user_names = {r.id: r.user_name or "" for r in u_rows}
        except Exception:
            pass

    written = 0
    for r in rows:
        total = int(r.rag_count or 0) + int(r.head_count or 0)
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_active_users
                    (run_id, target_date, kb_id, user_id, user_name,
                     rag_count, head_count, total_count)
                VALUES (:run_id, :target_date, :kb_id, :user_id, :user_name,
                        :rag_count, :head_count, :total_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "user_id": r.user_id,
                "user_name": user_names.get(r.user_id, str(r.user_id)),
                "rag_count": int(r.rag_count or 0),
                "head_count": int(r.head_count or 0),
                "total_count": total,
            },
        )
        written += 1
    return written


@register_collector(
    domain="retrieval",
    name="kb_rag_head_ratio",
    description="Per-KB daily RAG vs head injection ratio",
    chart_hint="line",
)
def kb_rag_head_ratio(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB daily RAG/head ratio from subtask_contexts."""
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(sc.created_at) AS d,
                   CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   SUM(CASE WHEN {RAG_RETRIEVAL_SQL} THEN 1 ELSE 0 END) AS rag_count,
                   SUM(CASE WHEN {KB_HEAD_SQL} THEN 1 ELSE 0 END) AS head_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(sc.created_at), kb_id
            ORDER BY d
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        rag = int(r.rag_count or 0)
        head = int(r.head_count or 0)
        rag_ratio = round(rag / (rag + head) * 100, 2) if (rag + head) > 0 else None

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_rag_head_ratio
                    (run_id, target_date, stat_date, kb_id,
                     rag_count, head_count, rag_ratio)
                VALUES (:run_id, :target_date, :stat_date, :kb_id,
                        :rag_count, :head_count, :rag_ratio)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": r.kb_id,
                "rag_count": rag,
                "head_count": head,
                "rag_ratio": rag_ratio,
            },
        )
        written += 1
    return written


@register_collector(
    domain="retrieval",
    name="kb_zero_chunk_rate",
    description="Per-KB zero-chunk query rate",
    chart_hint="line",
)
def kb_zero_chunk_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB zero-chunk query rate from subtask_contexts."""
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(sc.created_at) AS d,
                   CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   COUNT(*) AS total_queries,
                   SUM(CASE WHEN CAST(JSON_EXTRACT(sc.type_data, '$.rag_result.chunks_count') AS SIGNED) = 0
                        THEN 1 ELSE 0 END) AS zero_chunk_queries
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.rag_result') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(sc.created_at), kb_id
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        total = int(r.total_queries or 0)
        zero = int(r.zero_chunk_queries or 0)
        rate = round(zero / total * 100, 2) if total > 0 else None
        low_conf = 1 if 0 < total < LOW_CONFIDENCE_THRESHOLD else 0

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_zero_chunk_rate
                    (run_id, target_date, stat_date, kb_id, total_queries,
                     zero_chunk_queries, zero_chunk_rate, low_confidence)
                VALUES (:run_id, :target_date, :stat_date, :kb_id, :total_queries,
                        :zero_chunk_queries, :zero_chunk_rate, :low_confidence)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": r.kb_id,
                "total_queries": total,
                "zero_chunk_queries": zero,
                "zero_chunk_rate": rate,
                "low_confidence": low_conf,
            },
        )
        written += 1
    return written


@register_collector(
    domain="retrieval",
    name="kb_retrieval_mode_dist",
    description="Per-KB retrieval injection mode distribution",
    chart_hint="stacked_bar",
)
def kb_retrieval_mode_dist(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB injection mode distribution from subtask_contexts."""
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   JSON_UNQUOTE(JSON_EXTRACT(sc.type_data, '$.rag_result.injection_mode')) AS mode,
                   COUNT(*) AS call_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.rag_result') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY kb_id, mode
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        mode = r.mode or "unknown"
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_retrieval_mode_dist
                    (run_id, target_date, kb_id, injection_mode, call_count)
                VALUES (:run_id, :target_date, :kb_id, :injection_mode, :call_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "injection_mode": mode,
                "call_count": r.call_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# Retrieval quality: per-chunk relevance score distribution + low-score rate
# ---------------------------------------------------------------------------
# These two outputs share one pass over subtask_contexts because both read the
# same per-chunk `score` values stored in the extracted_text LONGTEXT JSON
# string (type_data itself does NOT carry scores). One collector writes two
# stat tables, mirroring the collect_period_and_daily pattern.

# Default relevance threshold when a KB has no score_threshold configured.
_DEFAULT_SCORE_THRESHOLD = 0.5


def _fetch_kb_score_thresholds(
    source_session: Session, kb_ids: list[int]
) -> dict[int, float]:
    """Map kb_id -> configured retrieval score_threshold (fallback 0.5).

    Thresholds live in the KnowledgeBase spec JSON at
    ``spec.retrievalConfig.score_threshold``.
    """
    kb_clause, kb_params = build_kb_in_clause(kb_ids) if kb_ids else ("", {})
    kb_where = f"AND id {kb_clause}" if kb_clause else ""
    rows = source_session.execute(
        text(
            f"""
            SELECT id,
                   JSON_UNQUOTE(
                       JSON_EXTRACT(json, '$.spec.retrievalConfig.score_threshold')
                   ) AS threshold
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1 {kb_where}
        """
        ),
        kb_params,
    ).fetchall()

    thresholds: dict[int, float] = {}
    for r in rows:
        try:
            thresholds[int(r.id)] = (
                float(r.threshold)
                if r.threshold is not None
                else _DEFAULT_SCORE_THRESHOLD
            )
        except (TypeError, ValueError):
            thresholds[int(r.id)] = _DEFAULT_SCORE_THRESHOLD
    return thresholds


def _percentile(sorted_values: list[float], pct: float) -> float | None:
    """Return the pct-th percentile (0..100) of a pre-sorted ascending list."""
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return round(sorted_values[0], 4)
    # Nearest-rank method.
    k = max(
        0,
        min(
            len(sorted_values) - 1, int(round((pct / 100.0) * (len(sorted_values) - 1)))
        ),
    )
    return round(sorted_values[k], 4)


@register_collector(
    domain="retrieval",
    name="retrieval_score_distribution",
    description="Per-KB retrieval relevance score distribution (avg/P50/P90 + low-score rate)",
    chart_hint="line",
)
def retrieval_score_distribution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB per-day chunk-relevance score distribution + low-score rate.

    Writes two tables in one pass (kb_stat_retrieval_score_distribution and
    kb_stat_kb_low_score_rate) to avoid double-scanning the extracted_text
    LONGTEXT column. Scores come only from rag_retrieval mode rows whose
    extracted_text JSON carries a ``chunks[].score`` value.
    """
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    # Pull the raw rows; we parse the LONGTEXT JSON in Python because
    # JSON_EXTRACT over LONGTEXT (vs a native JSON column) is unreliable
    # across MySQL versions and there is no precedent for it in collectors.
    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(sc.created_at) AS d,
                   CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   sc.extracted_text
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.extracted_text IS NOT NULL
              AND sc.extracted_text != ''
              AND JSON_EXTRACT(sc.type_data, '$.rag_result.injection_mode')
                  = 'rag_retrieval'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    # Aggregate scores per (kb_id, date) in memory so we write one row per day.
    #   kb_day_scores[(kb_id, date)] = list of all chunk scores
    #   kb_day_low[(kb_id, date)]    = (total_queries, low_score_queries)
    kb_day_scores: dict[tuple, list[float]] = defaultdict(list)
    kb_day_low: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])

    thresholds = _fetch_kb_score_thresholds(source_session, list(mfilter.kb_ids or []))

    for r in rows:
        kb_id = int(r.kb_id) if r.kb_id is not None else 0
        if kb_id == 0:
            continue
        try:
            payload = json.loads(r.extracted_text) if r.extracted_text else {}
        except (json.JSONDecodeError, TypeError):
            continue
        chunks = payload.get("chunks") if isinstance(payload, dict) else None
        if not chunks or not isinstance(chunks, list):
            continue

        chunk_scores = [
            float(c["score"])
            for c in chunks
            if isinstance(c, dict) and c.get("score") is not None
        ]
        if not chunk_scores:
            continue

        key = (kb_id, r.d)
        kb_day_scores[key].extend(chunk_scores)
        avg = sum(chunk_scores) / len(chunk_scores)
        threshold = thresholds.get(kb_id, _DEFAULT_SCORE_THRESHOLD)
        kb_day_low[key][0] += 1
        if avg < threshold:
            kb_day_low[key][1] += 1

    written = 0
    for (kb_id, stat_date), scores in kb_day_scores.items():
        scores_sorted = sorted(scores)
        threshold = thresholds.get(kb_id, _DEFAULT_SCORE_THRESHOLD)
        low_count = sum(1 for s in scores_sorted if s < threshold)
        avg_score = round(sum(scores_sorted) / len(scores_sorted), 4)
        p50 = _percentile(scores_sorted, 50)
        p90 = _percentile(scores_sorted, 90)
        low_score_rate = round(low_count / len(scores_sorted) * 100, 2)

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_retrieval_score_distribution
                    (run_id, target_date, stat_date, kb_id, total_samples,
                     avg_score, p50_score, p90_score,
                     score_threshold, low_score_rate)
                VALUES (:run_id, :target_date, :stat_date, :kb_id, :total_samples,
                        :avg_score, :p50_score, :p90_score,
                        :score_threshold, :low_score_rate)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": stat_date,
                "kb_id": kb_id,
                "total_samples": len(scores_sorted),
                "avg_score": avg_score,
                "p50_score": p50,
                "p90_score": p90,
                "score_threshold": threshold,
                "low_score_rate": low_score_rate,
            },
        )
        written += 1

    # Second table: per-KB per-day low-score query rate.
    for (kb_id, stat_date), (total, low) in kb_day_low.items():
        rate = round(low / total * 100, 2) if total > 0 else None
        low_conf = 1 if 0 < total < LOW_CONFIDENCE_THRESHOLD else 0
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_low_score_rate
                    (run_id, target_date, stat_date, kb_id, total_queries,
                     low_score_queries, low_score_rate, low_confidence)
                VALUES (:run_id, :target_date, :stat_date, :kb_id, :total_queries,
                        :low_score_queries, :low_score_rate, :low_confidence)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": stat_date,
                "kb_id": kb_id,
                "total_queries": total,
                "low_score_queries": low,
                "low_score_rate": rate,
                "low_confidence": low_conf,
            },
        )

    return written


# ---------------------------------------------------------------------------
# Answer adoption rate: share of RAG calls whose sources were cited by the LLM
# ---------------------------------------------------------------------------


@register_collector(
    domain="retrieval",
    name="answer_adoption_rate",
    description="Per-KB share of RAG calls whose retrieved sources were cited by the LLM",
    chart_hint="line",
)
def answer_adoption_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB answer adoption rate from adoption_result.

    adoption_result is written post-LLM-response by the completion path; it
    records how many retrieved sources the model actually cited. When the
    runtime does not populate cited sources, adoption_result is absent and the
    KB contributes no row (graceful degradation).
    """
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(sc.created_at) AS d,
                   CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   COUNT(*) AS total_queries,
                   SUM(CASE
                       WHEN JSON_EXTRACT(sc.type_data, '$.adoption_result.cited_count') > 0
                       THEN 1 ELSE 0 END) AS adopted_queries
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.adoption_result') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(sc.created_at), kb_id
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        total = int(r.total_queries or 0)
        adopted = int(r.adopted_queries or 0)
        rate = round(adopted / total * 100, 2) if total > 0 else None
        low_conf = 1 if 0 < total < LOW_CONFIDENCE_THRESHOLD else 0

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_answer_adoption_rate
                    (run_id, target_date, stat_date, kb_id, total_queries,
                     adopted_queries, adoption_rate, low_confidence)
                VALUES (:run_id, :target_date, :stat_date, :kb_id, :total_queries,
                        :adopted_queries, :adoption_rate, :low_confidence)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": r.kb_id,
                "total_queries": total,
                "adopted_queries": adopted,
                "adoption_rate": rate,
                "low_confidence": low_conf,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# P3 additions: hit rate, dedup rate, slow query rate
# ---------------------------------------------------------------------------


@register_collector(
    domain="retrieval",
    name="kb_retrieval_hit_rate",
    description=(
        "Per-KB retrieval hit rate. hit_rate = hit_queries / total_queries * 100. "
        "Complementary to kb_zero_chunk_rate (hit_rate = 100 - zero_chunk_rate)."
    ),
    chart_hint="line",
)
def kb_retrieval_hit_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(sc.created_at) AS d,
                   CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   COUNT(*) AS total_queries,
                   SUM(CASE WHEN CAST(JSON_EXTRACT(sc.type_data, '$.rag_result.chunks_count') AS SIGNED) > 0
                        THEN 1 ELSE 0 END) AS hit_queries
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.rag_result') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(sc.created_at), kb_id
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        kb_id = int(r.kb_id or 0)
        if kb_id == 0:
            continue
        total = int(r.total_queries or 0)
        hit = int(r.hit_queries or 0)
        rate = round(hit / total * 100, 2) if total > 0 else None
        low_conf = 1 if 0 < total < LOW_CONFIDENCE_THRESHOLD else 0

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_retrieval_hit_rate
                    (run_id, target_date, stat_date, kb_id, total_queries,
                     hit_queries, hit_rate, low_confidence)
                VALUES (:run_id, :target_date, :stat_date, :kb_id, :total_queries,
                        :hit_queries, :hit_rate, :low_confidence)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": kb_id,
                "total_queries": total,
                "hit_queries": hit,
                "hit_rate": rate,
                "low_confidence": low_conf,
            },
        )
        written += 1
    return written


@register_collector(
    domain="retrieval",
    name="query_dedup_rate",
    description=(
        "Per-KB query deduplication rate. "
        "dedup_rate = unique_queries / total_queries * 100. "
        "Low dedup_rate means users repeat similar queries, suggesting "
        "the KB fails to answer common questions on the first try."
    ),
    chart_hint="line",
)
def query_dedup_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB per-day query dedup rate.

    Reads rag_result.query from subtask_contexts.type_data, normalizes
    (lowercase + strip) so case/whitespace variants collapse, then
    computes unique/total per (KB, day).
    """
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(sc.created_at) AS d,
                   CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   LOWER(TRIM(JSON_UNQUOTE(
                       JSON_EXTRACT(sc.type_data, '$.rag_result.query')
                   ))) AS q
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.rag_result.query') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    # Aggregate per (kb_id, date) so we write one row per day.
    per_kb_day: dict[tuple, set[str]] = defaultdict(set)
    per_kb_day_total: dict[tuple, int] = defaultdict(int)
    for r in rows:
        kb_id = int(r.kb_id or 0)
        if kb_id == 0 or not r.q:
            continue
        key = (kb_id, r.d)
        per_kb_day[key].add(r.q)
        per_kb_day_total[key] += 1

    written = 0
    for (kb_id, stat_date), unique_set in per_kb_day.items():
        total = per_kb_day_total[(kb_id, stat_date)]
        unique = len(unique_set)
        rate = round(unique / total * 100, 2) if total > 0 else None
        low_conf = 1 if 0 < total < LOW_CONFIDENCE_THRESHOLD else 0

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_query_dedup_rate
                    (run_id, target_date, stat_date, kb_id, total_queries,
                     unique_queries, dedup_rate, low_confidence)
                VALUES (:run_id, :target_date, :stat_date, :kb_id, :total_queries,
                        :unique_queries, :dedup_rate, :low_confidence)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": stat_date,
                "kb_id": kb_id,
                "total_queries": total,
                "unique_queries": unique,
                "dedup_rate": rate,
                "low_confidence": low_conf,
            },
        )
        written += 1
    return written


@register_collector(
    domain="retrieval",
    name="kb_slow_query_rate",
    description=(
        "Per-KB slow-query rate. P95 latency computed from rag_result.latency_ms; "
        "queries above the P95 are counted as slow. "
        "slow_rate = slow_queries / total_queries * 100."
    ),
    chart_hint="cards",
)
def kb_slow_query_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB slow-query rate (share of queries above a fixed 2s cutoff)."""
    kb_filter_sql, kb_params = _kb_json_filter(mfilter)

    rows = source_session.execute(
        text(
            f"""
            SELECT CAST(JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS SIGNED) AS kb_id,
                   CAST(JSON_EXTRACT(sc.type_data, '$.rag_result.latency_ms') AS DECIMAL(20,4)) AS latency_ms
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND JSON_EXTRACT(sc.type_data, '$.rag_result.latency_ms') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
              {kb_filter_sql}
        """
        ),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    per_kb_lat: dict[int, list[float]] = defaultdict(list)
    for r in rows:
        kb_id = int(r.kb_id or 0)
        if kb_id == 0 or r.latency_ms is None:
            continue
        try:
            per_kb_lat[kb_id].append(float(r.latency_ms))
        except (TypeError, ValueError):
            continue

    written = 0
    for kb_id, lats in per_kb_lat.items():
        if not lats:
            continue
        lats_sorted = sorted(lats)
        total = len(lats_sorted)
        p95 = _percentile(lats_sorted, 95)
        # "Slow" is a fixed 2s cutoff, NOT "above the KB's own P95": the
        # self-referential percentile definition collapses to ~0% on small
        # samples (total<21) because the P95 index sits outside the array,
        # masking genuinely slow queries. The fixed threshold is sample-size
        # independent. We still record p95_latency_ms for observability.
        slow = sum(1 for v in lats_sorted if v > SLOW_LATENCY_MS)
        rate = round(slow / total * 100, 2) if total > 0 else None
        low_conf = 1 if 0 < total < LOW_CONFIDENCE_THRESHOLD else 0

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_slow_query_rate
                    (run_id, target_date, kb_id, total_queries,
                     slow_queries, p95_latency_ms, slow_rate, low_confidence)
                VALUES (:run_id, :target_date, :kb_id, :total_queries,
                        :slow_queries, :p95_latency_ms, :slow_rate, :low_confidence)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": kb_id,
                "total_queries": total,
                "slow_queries": slow,
                "p95_latency_ms": p95,
                "slow_rate": rate,
                "low_confidence": low_conf,
            },
        )
        written += 1
    return written
