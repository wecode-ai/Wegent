# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document management domain collectors (upload, index, chunk, summary stats)."""

import json
import logging
from collections import defaultdict

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Size bucket thresholds (bytes)
# ---------------------------------------------------------------------------
_SIZE_BUCKETS = [
    ("<100KB", 0, 100 * 1024),
    ("100KB-1MB", 100 * 1024, 1024 * 1024),
    ("1-5MB", 1024 * 1024, 5 * 1024 * 1024),
    ("5-10MB", 5 * 1024 * 1024, 10 * 1024 * 1024),
    (">10MB", 10 * 1024 * 1024, None),
]

_CHUNK_BUCKETS = [
    ("0", 0, 0),
    ("1-4", 1, 4),
    ("5-10", 5, 10),
    ("11-20", 11, 20),
    ("21-50", 21, 50),
    (">50", 51, None),
]


def _classify_size(file_size: int) -> str:
    """Return the size bucket label for a given byte count."""
    for label, lo, hi in _SIZE_BUCKETS:
        if hi is None:
            return label
        if lo <= file_size < hi:
            return label
    return _SIZE_BUCKETS[0][0]


def _classify_chunk_count(count: int) -> str:
    """Return the chunk-count bucket label."""
    for label, lo, hi in _CHUNK_BUCKETS:
        if hi is None:
            return label
        if lo <= count <= hi:
            return label
    return _CHUNK_BUCKETS[0][0]


# ---------------------------------------------------------------------------
# 1. doc_upload_trend
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_upload_trend",
    description="Document upload trends",
    chart_hint="stacked_bar",
)
def doc_upload_trend(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT DATE(created_at) AS d,
                   kind_id AS kb_id,
                   file_extension,
                   source_type,
                   user_id,
                   COUNT(*) AS upload_count
            FROM knowledge_documents
            WHERE is_active = 1
              AND created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND created_at < :end_date
              {kb_where}
            GROUP BY DATE(created_at), kind_id, file_extension, source_type, user_id
        """),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
            **kb_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_upload_trend
                    (run_id, target_date, stat_date, kb_id,
                     file_extension, source_type, user_id, upload_count)
                VALUES (:run_id, :target_date, :stat_date, :kb_id,
                        :file_extension, :source_type, :user_id, :upload_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": r.kb_id,
                "file_extension": r.file_extension or "",
                "source_type": r.source_type or "",
                "user_id": r.user_id or 0,
                "upload_count": r.upload_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 2. doc_index_status
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_index_status",
    description="Document index status distribution",
    chart_hint="table",
)
def doc_index_status(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT index_status,
                   file_extension,
                   kind_id AS kb_id,
                   COUNT(*) AS doc_count
            FROM knowledge_documents
            WHERE is_active = 1
              {kb_where}
            GROUP BY index_status, file_extension, kind_id
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_index_status
                    (run_id, target_date, index_status, file_extension,
                     kb_id, doc_count)
                VALUES (:run_id, :target_date, :index_status, :file_extension,
                        :kb_id, :doc_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "index_status": r.index_status or "",
                "file_extension": r.file_extension or "",
                "kb_id": r.kb_id,
                "doc_count": r.doc_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 3. doc_index_failure_rate
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_index_failure_rate",
    description="Index failure rate by file type",
    chart_hint="line",
)
def doc_index_failure_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT file_extension,
                   COUNT(*) AS total,
                   SUM(CASE WHEN index_status = 'failed' THEN 1 ELSE 0 END) AS failed,
                   ROUND(
                       SUM(CASE WHEN index_status = 'failed' THEN 1 ELSE 0 END)
                       / COUNT(*) * 100, 2
                   ) AS rate
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
                INSERT INTO kb_stat_doc_index_failure_rate
                    (run_id, target_date, file_extension,
                     total_count, failed_count, failure_rate)
                VALUES (:run_id, :target_date, :file_extension,
                        :total_count, :failed_count, :failure_rate)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "file_extension": r.file_extension or "",
                "total_count": r.total,
                "failed_count": r.failed,
                "failure_rate": r.rate,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 4. doc_size_distribution
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_size_distribution",
    description="Document size distribution (bucketed)",
    chart_hint="pie",
)
def doc_size_distribution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT file_size
            FROM knowledge_documents
            WHERE is_active = 1
              {kb_where}
        """),
        kb_params,
    ).fetchall()

    # Bucket in Python
    buckets: dict[str, list[int]] = defaultdict(list)
    for r in rows:
        size = int(r.file_size or 0)
        label = _classify_size(size)
        buckets[label].append(size)

    written = 0
    for label, sizes in buckets.items():
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_size_distribution
                    (run_id, target_date, size_bucket, doc_count, total_size)
                VALUES (:run_id, :target_date, :size_bucket, :doc_count, :total_size)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "size_bucket": label,
                "doc_count": len(sizes),
                "total_size": sum(sizes),
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 5. doc_update_frequency
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_update_frequency",
    description="Document re-index frequency",
    chart_hint="table",
)
def doc_update_frequency(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT kind_id AS kb_id,
                   file_extension,
                   index_generation,
                   COUNT(*) AS doc_count
            FROM knowledge_documents
            WHERE is_active = 1
              AND index_generation > 1
              {kb_where}
            GROUP BY kind_id, file_extension, index_generation
            ORDER BY index_generation DESC
            LIMIT 500
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_update_frequency
                    (run_id, target_date, kb_id, file_extension,
                     index_generation, doc_count)
                VALUES (:run_id, :target_date, :kb_id, :file_extension,
                        :index_generation, :doc_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "file_extension": r.file_extension or "",
                "index_generation": r.index_generation,
                "doc_count": r.doc_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 6. doc_topic_distribution
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_topic_distribution",
    description="Document topic distribution (from summary JSON)",
    chart_hint="stacked_bar",
)
def doc_topic_distribution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT kind_id AS kb_id, summary
            FROM knowledge_documents
            WHERE is_active = 1
              {kb_where}
        """),
        kb_params,
    ).fetchall()

    # Parse summary JSON and aggregate (kb_id, topic) -> count
    topic_counts: dict[tuple[int, str], int] = defaultdict(int)
    for r in rows:
        if not r.summary:
            continue
        try:
            summary_obj = (
                json.loads(r.summary) if isinstance(r.summary, str) else r.summary
            )
        except (json.JSONDecodeError, TypeError):
            continue
        topics = summary_obj.get("topics") or []
        if isinstance(topics, list):
            for topic in topics:
                topic_str = str(topic).strip()
                if topic_str:
                    topic_counts[(r.kb_id, topic_str)] += 1

    written = 0
    for (kb_id, topic), count in topic_counts.items():
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_topic_distribution
                    (run_id, target_date, kb_id, topic, doc_count)
                VALUES (:run_id, :target_date, :kb_id, :topic, :doc_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": kb_id,
                "topic": topic,
                "doc_count": count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 7. doc_folder_depth
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_folder_depth",
    description="Document folder tree depth distribution",
    chart_hint="table",
)
def doc_folder_depth(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kb.id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT kb.id AS kb_id,
                   kf.id AS folder_id,
                   kf.parent_id
            FROM kinds kb
            LEFT JOIN knowledge_folders kf ON kf.kind_id = kb.id
            WHERE kb.kind = 'KnowledgeBase'
              AND kb.is_active = 1
              {kb_where}
        """),
        kb_params,
    ).fetchall()

    # Build per-KB parent maps and compute depth for each folder
    kb_folders: dict[int, dict[int, int | None]] = defaultdict(dict)
    for r in rows:
        if r.folder_id is None:
            continue
        kb_folders[r.kb_id][r.folder_id] = r.parent_id

    def _compute_depth(
        folder_id: int, parent_map: dict[int, int | None], cache: dict[int, int]
    ) -> int:
        if folder_id in cache:
            return cache[folder_id]
        parent_id = parent_map.get(folder_id)
        if parent_id is None or parent_id not in parent_map:
            cache[folder_id] = 1
            return 1
        depth = _compute_depth(parent_id, parent_map, cache) + 1
        cache[folder_id] = depth
        return depth

    # Aggregate (kb_id, depth) -> folder_count
    depth_counts: dict[tuple[int, int], int] = defaultdict(int)
    for kb_id, parent_map in kb_folders.items():
        cache: dict[int, int] = {}
        for folder_id in parent_map:
            d = _compute_depth(folder_id, parent_map, cache)
            depth_counts[(kb_id, d)] += 1

    written = 0
    for (kb_id, depth), count in depth_counts.items():
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_folder_depth
                    (run_id, target_date, kb_id, depth, folder_count)
                VALUES (:run_id, :target_date, :kb_id, :depth, :folder_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": kb_id,
                "depth": depth,
                "folder_count": count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 8. doc_chunk_strategy
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_chunk_strategy",
    description="Chunk splitter type distribution",
    chart_hint="table",
)
def doc_chunk_strategy(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT JSON_UNQUOTE(JSON_EXTRACT(chunks, '$.splitter_type')) AS splitter_type,
                   file_extension,
                   COUNT(*) AS doc_count
            FROM knowledge_documents
            WHERE is_active = 1
              AND chunks IS NOT NULL
              {kb_where}
            GROUP BY splitter_type, file_extension
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_chunk_strategy
                    (run_id, target_date, splitter_type, file_extension, doc_count)
                VALUES (:run_id, :target_date, :splitter_type, :file_extension, :doc_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "splitter_type": r.splitter_type or "",
                "file_extension": r.file_extension or "",
                "doc_count": r.doc_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 9. doc_chunk_count_distribution
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_chunk_count_distribution",
    description="Chunk count distribution (bucketed)",
    chart_hint="pie",
)
def doc_chunk_count_distribution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT CAST(JSON_EXTRACT(chunks, '$.total_count') AS SIGNED) AS total_count
            FROM knowledge_documents
            WHERE is_active = 1
              AND chunks IS NOT NULL
              {kb_where}
        """),
        kb_params,
    ).fetchall()

    # Bucket in Python
    buckets: dict[str, int] = defaultdict(int)
    for r in rows:
        count = int(r.total_count or 0)
        label = _classify_chunk_count(count)
        buckets[label] += 1

    written = 0
    for label, doc_count in buckets.items():
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_chunk_count_distribution
                    (run_id, target_date, chunk_bucket, doc_count)
                VALUES (:run_id, :target_date, :chunk_bucket, :doc_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "chunk_bucket": label,
                "doc_count": doc_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 10. doc_summary_status
# ---------------------------------------------------------------------------
@register_collector(
    domain="doc_management",
    name="doc_summary_status",
    description="Document summary generation status",
    chart_hint="pie",
)
def doc_summary_status(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT JSON_UNQUOTE(JSON_EXTRACT(summary, '$.status')) AS summary_status,
                   COUNT(*) AS doc_count
            FROM knowledge_documents
            WHERE is_active = 1
              AND summary IS NOT NULL
              {kb_where}
            GROUP BY summary_status
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_summary_status
                    (run_id, target_date, summary_status, doc_count)
                VALUES (:run_id, :target_date, :summary_status, :doc_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "summary_status": r.summary_status or "",
                "doc_count": r.doc_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# P3: per-KB average document length (content depth signal)
# ---------------------------------------------------------------------------


@register_collector(
    domain="doc_management",
    name="kb_avg_doc_length",
    description=(
        "Per-KB average document file size (KB). Proxy for content depth: "
        "very small averages suggest parsing failures, empty uploads, or "
        "thin content. Uses file_size rather than parsed text length "
        "because the latter is not stored on knowledge_documents."
    ),
    chart_hint="cards",
)
def kb_avg_doc_length(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT kind_id AS kb_id,
                   COUNT(*) AS total_docs,
                   AVG(file_size) AS avg_size
            FROM knowledge_documents
            WHERE is_active = 1
              AND file_size IS NOT NULL
              AND file_size > 0
              {kb_where}
            GROUP BY kind_id
        """),
        kb_params,
    ).fetchall()

    # Median via a separate per-KB query — MySQL 8 has MEDIAN() only via
    # window functions; we approximate with a second pass that pulls all
    # file_sizes per KB. For deployments where the perf cost matters the
    # avg alone is enough; median is a nice-to-have. Skip median when the
    # per-KB row count is too large (>50k) to avoid loading it in Python.
    written = 0
    for r in rows:
        kb_id = int(r.kb_id or 0)
        if kb_id == 0:
            continue
        total = int(r.total_docs or 0)
        avg_kb = round(float(r.avg_size or 0) / 1024.0, 2) if r.avg_size else None
        median_kb = None
        if 0 < total <= 50000:
            sizes = [
                int(row[0] or 0)
                for row in source_session.execute(
                    text(
                        "SELECT file_size FROM knowledge_documents "
                        "WHERE is_active = 1 AND kind_id = :kb_id "
                        "AND file_size IS NOT NULL AND file_size > 0"
                    ),
                    {"kb_id": kb_id},
                ).fetchall()
            ]
            if sizes:
                sizes.sort()
                k = max(0, min(len(sizes) - 1, int(round(0.5 * (len(sizes) - 1)))))
                median_kb = round(sizes[k] / 1024.0, 2)

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_kb_avg_doc_length
                    (run_id, target_date, kb_id, total_docs,
                     avg_doc_length, median_doc_length)
                VALUES (:run_id, :target_date, :kb_id, :total_docs,
                        :avg_doc_length, :median_doc_length)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": kb_id,
                "total_docs": total,
                "avg_doc_length": avg_kb,
                "median_doc_length": median_kb,
            },
        )
        written += 1
    return written
