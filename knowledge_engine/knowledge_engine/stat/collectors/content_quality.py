# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Content quality domain collectors.

These metrics surface content-debt signals that volume-based doc_management
metrics miss: thin documents (near-empty), and chunk-size health (oversized
or undersized chunks indicating poor splitter configuration).

Data source: the ``chunks`` JSON column on knowledge_documents, which is a
native JSON column carrying ``{total_count, items:[{token_count, ...}], ...}``.
Unlike extracted_text (LONGTEXT), this column supports JSON_EXTRACT directly.
"""

import json
import logging
from collections import Counter, defaultdict

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector

logger = logging.getLogger(__name__)

# A document is "thin" when it produced at most one chunk — meaning it had
# little indexable content. This usually indicates an empty/trivial upload or
# a parsing failure that silently produced no chunks.
_THIN_CHUNK_THRESHOLD = 1

# Chunk-size quality buckets, by average token_count per chunk.
# token_count already lives on every chunk item but was unused by any metric.
_CHUNK_QUALITY_BUCKETS = [
    ("undersized(<100)", lambda avg: avg < 100),
    ("healthy(100-500)", lambda avg: 100 <= avg <= 500),
    ("oversized(>500)", lambda avg: avg > 500),
]


def _classify_chunk_quality(avg_token: float) -> str:
    """Return the quality bucket label for an average chunk token count."""
    for label, predicate in _CHUNK_QUALITY_BUCKETS:
        if predicate(avg_token):
            return label
    return "healthy(100-500)"


# ---------------------------------------------------------------------------
# 1. thin_doc_alert — per-KB share of near-empty documents
# ---------------------------------------------------------------------------


@register_collector(
    domain="content_quality",
    name="thin_doc_alert",
    description="Per-KB share of thin documents (<=1 chunk), a content-debt signal",
    chart_hint="line",
)
def thin_doc_alert(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB per-day thin-document rate from chunks JSON column."""
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND kd.kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(kd.created_at) AS d,
                   kd.kind_id AS kb_id,
                   COUNT(*) AS total_docs,
                   SUM(CASE
                       WHEN CAST(JSON_EXTRACT(kd.chunks, '$.total_count') AS SIGNED)
                            <= :thin THEN 1 ELSE 0 END) AS thin_docs
            FROM knowledge_documents kd
            WHERE kd.is_active = 1
              AND kd.chunks IS NOT NULL
              AND kd.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND kd.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(kd.created_at), kd.kind_id
        """
        ),
        {
            "thin": _THIN_CHUNK_THRESHOLD,
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        total = int(r.total_docs or 0)
        thin = int(r.thin_docs or 0)
        rate = round(thin / total * 100, 2) if total > 0 else None

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_thin_doc_alert
                    (run_id, target_date, stat_date, kb_id, total_docs,
                     thin_docs, thin_doc_rate)
                VALUES (:run_id, :target_date, :stat_date, :kb_id, :total_docs,
                        :thin_docs, :thin_doc_rate)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": r.kb_id,
                "total_docs": total,
                "thin_docs": thin,
                "thin_doc_rate": rate,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 2. doc_chunk_quality — global chunk-size health distribution
# ---------------------------------------------------------------------------


@register_collector(
    domain="content_quality",
    name="doc_chunk_quality",
    description="Document chunk-size quality distribution (undersized/healthy/oversized)",
    chart_hint="pie",
)
def doc_chunk_quality(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect global chunk-size quality distribution.

    For each document we compute the average token_count of its chunks, then
    bucket it. Oversized chunks suggest the splitter config is too coarse;
    undersized chunks suggest wasted indexing or trivial content. This reads
    the items array from the chunks JSON; since the array length varies, we
    compute the mean in Python rather than via SQL aggregation.
    """
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(
            f"""
            SELECT JSON_EXTRACT(chunks, '$.items') AS items_json
            FROM knowledge_documents
            WHERE is_active = 1
              AND chunks IS NOT NULL
              {kb_filter_sql}
        """
        ),
        kb_params,
    ).fetchall()

    bucket_counter: Counter[str] = Counter()
    for r in rows:
        items = r.items_json
        # items_json may come back as a Python object (native JSON col) or a
        # JSON string depending on the driver; normalize both.
        if isinstance(items, str):
            try:
                items = json.loads(items)
            except (json.JSONDecodeError, TypeError):
                items = None
        if not items or not isinstance(items, list):
            continue

        token_counts = [
            int(it.get("token_count", 0))
            for it in items
            if isinstance(it, dict) and it.get("token_count") is not None
        ]
        if not token_counts:
            continue
        avg_token = sum(token_counts) / len(token_counts)
        bucket_counter[_classify_chunk_quality(avg_token)] += 1

    written = 0
    for bucket, doc_count in bucket_counter.items():
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_doc_chunk_quality
                    (run_id, target_date, chunk_quality_bucket, doc_count)
                VALUES (:run_id, :target_date, :chunk_quality_bucket, :doc_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "chunk_quality_bucket": bucket,
                "doc_count": doc_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 3. content_freshness — global document freshness distribution
# ---------------------------------------------------------------------------

_FRESHNESS_BUCKETS = [
    ("≤7天", lambda d: d <= 7),
    ("8-30天", lambda d: 8 <= d <= 30),
    ("31-90天", lambda d: 31 <= d <= 90),
    ("91-180天", lambda d: 91 <= d <= 180),
    (">180天", lambda d: d > 180),
]


def _classify_freshness(days: int) -> str:
    """Return the freshness bucket label for a days-since-update value."""
    for label, predicate in _FRESHNESS_BUCKETS:
        if predicate(days):
            return label
    return ">180天"


@register_collector(
    domain="content_quality",
    name="content_freshness",
    description="Document freshness distribution by days since last update",
    chart_hint="pie",
)
def content_freshness(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect global document freshness distribution from updated_at.

    Buckets documents by how recently they were updated relative to the
    collection target date. Stale-heavy distributions indicate content debt.
    """
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(
            f"""
            SELECT updated_at
            FROM knowledge_documents
            WHERE is_active = 1
              {kb_filter_sql}
        """
        ),
        kb_params,
    ).fetchall()

    ref_date = mfilter.period_end_date
    bucket_counter: Counter[str] = Counter()
    for r in rows:
        if r.updated_at is None:
            continue
        days = (ref_date - r.updated_at.date()).days
        if days < 0:
            days = 0
        bucket_counter[_classify_freshness(days)] += 1

    written = 0
    for bucket, doc_count in bucket_counter.items():
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_content_freshness
                    (run_id, target_date, freshness_bucket, doc_count)
                VALUES (:run_id, :target_date, :freshness_bucket, :doc_count)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "freshness_bucket": bucket,
                "doc_count": doc_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 4. kb_content_freshness — per-KB freshness rate
# ---------------------------------------------------------------------------


@register_collector(
    domain="content_quality",
    name="kb_content_freshness",
    description="Per-KB content freshness rate (docs updated within 30 days)",
    chart_hint="cards",
)
def kb_content_freshness(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB freshness rate: share of docs updated within 30 days."""
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(
            f"""
            SELECT kind_id AS kb_id,
                   COUNT(*) AS total_docs,
                   SUM(CASE WHEN updated_at >= DATE_SUB(:cutoff, INTERVAL 30 DAY)
                       THEN 1 ELSE 0 END) AS fresh_docs
            FROM knowledge_documents
            WHERE is_active = 1
              {kb_filter_sql}
            GROUP BY kind_id
        """
        ),
        {"cutoff": mfilter.effective_end_date, **kb_params},
    ).fetchall()

    written = 0
    for r in rows:
        total = int(r.total_docs or 0)
        fresh = int(r.fresh_docs or 0)
        rate = round(fresh / total * 100, 2) if total > 0 else None

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_content_freshness
                    (run_id, target_date, kb_id, total_docs,
                     fresh_docs, fresh_rate)
                VALUES (:run_id, :target_date, :kb_id, :total_docs,
                        :fresh_docs, :fresh_rate)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "total_docs": total,
                "fresh_docs": fresh,
                "fresh_rate": rate,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 5. duplicate_doc_suspect — per-KB likely-duplicate document detection
# ---------------------------------------------------------------------------


@register_collector(
    domain="content_quality",
    name="duplicate_doc_suspect",
    description="Per-KB likely-duplicate document rate (same size + extension)",
    chart_hint="table",
)
def duplicate_doc_suspect(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Detect likely-duplicate documents within each KB.

    Heuristic: documents sharing the same (file_size, file_extension) within
    a KB are treated as a duplicate group. This is a cheap signal that needs
    no vector similarity; exact-name or content dedup can layer on top later.
    """
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(
            f"""
            SELECT kind_id AS kb_id,
                   file_size,
                   file_extension,
                   COUNT(*) AS cnt
            FROM knowledge_documents
            WHERE is_active = 1
              AND file_size > 0
              {kb_filter_sql}
            GROUP BY kind_id, file_size, file_extension
        """
        ),
        kb_params,
    ).fetchall()

    # Aggregate per KB: docs involved in duplicate groups (cnt > 1).
    kb_dup: dict[int, int] = defaultdict(int)
    for r in rows:
        if r.cnt and int(r.cnt) > 1:
            kb_dup[int(r.kb_id)] += int(r.cnt)

    if not kb_dup:
        return 0

    total_rows = source_session.execute(
        text(
            f"""
            SELECT kind_id AS kb_id, COUNT(*) AS total_docs
            FROM knowledge_documents
            WHERE is_active = 1 AND file_size > 0
              {kb_filter_sql}
            GROUP BY kind_id
        """
        ),
        kb_params,
    ).fetchall()
    kb_total = {int(r.kb_id): int(r.total_docs) for r in total_rows}

    written = 0
    for kb_id, dup_docs in kb_dup.items():
        total = kb_total.get(kb_id, 0)
        rate = round(dup_docs / total * 100, 2) if total > 0 else None

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_duplicate_doc_suspect
                    (run_id, target_date, kb_id, total_docs,
                     duplicate_docs, duplicate_rate)
                VALUES (:run_id, :target_date, :kb_id, :total_docs,
                        :duplicate_docs, :duplicate_rate)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": kb_id,
                "total_docs": total,
                "duplicate_docs": dup_docs,
                "duplicate_rate": rate,
            },
        )
        written += 1
    return written
