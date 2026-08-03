# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""KB lifecycle domain collectors."""

import json
import logging
from collections import Counter, defaultdict
from datetime import timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector
from knowledge_engine.stat.source import fetch_kb_metadata

logger = logging.getLogger(__name__)

STALE_THRESHOLD_DAYS = 90
INACTIVE_THRESHOLD_DAYS = 30


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _size_bucket(total_bytes: int) -> str:
    """Classify total file size into a human-readable bucket."""
    if total_bytes < 1_000_000:  # < 1 MB
        return "<1MB"
    if total_bytes < 10_000_000:  # < 10 MB
        return "1-10MB"
    if total_bytes < 100_000_000:  # < 100 MB
        return "10-100MB"
    return ">100MB"


# ---------------------------------------------------------------------------
# 1. kb_creation_trend
# ---------------------------------------------------------------------------


@register_collector(
    domain="kb_lifecycle",
    description="Daily KB creation counts by namespace with cumulative window",
    chart_hint="line",
)
def kb_creation_trend(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect a continuous daily KB-creation series per namespace.

    A day with no new KB is still written with ``new_kb_count=0`` and a
    carried-forward cumulative, so the trend line has no gaps. Without this
    fill, days with zero creation are absent from the table and the chart
    only plots the days that had creations.
    """
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND id {kb_clause}" if kb_clause else ""

    start = mfilter.effective_period_start
    end = mfilter.period_end_date
    from datetime import timedelta as _td

    # Namespaces that own at least one KB up to the end of the window. Each
    # gets a row for every day so the series is gapless even when a whole
    # namespace has no creation in the window.
    ns_rows = source_session.execute(
        text(f"""
            SELECT DISTINCT namespace
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              AND created_at < :end_date
              {kb_filter_sql}
        """),
        {"end_date": mfilter.effective_end_date, **kb_params},
    ).fetchall()
    namespaces = [r.namespace for r in ns_rows if r.namespace is not None]
    if not namespaces:
        return 0

    # Per-day per-namespace creation counts within the window.
    count_rows = source_session.execute(
        text(f"""
            SELECT DATE(created_at) AS d, namespace,
                   COUNT(*) AS new_kb
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              AND created_at >= :start_date
              AND created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(created_at), namespace
        """),
        {
            "start_date": start,
            "end_date": mfilter.effective_end_date,
            **kb_params,
        },
    ).fetchall()
    counts: dict[tuple, int] = {(r.d, r.namespace): int(r.new_kb) for r in count_rows}

    # KB count created before the window per namespace — the cumulative
    # baseline so the running total reflects true all-time growth rather
    # than resetting at the window start.
    base_rows = source_session.execute(
        text(f"""
            SELECT namespace, COUNT(*) AS base_kb
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              AND created_at < :start_date
              {kb_filter_sql}
            GROUP BY namespace
        """),
        {"start_date": start, **kb_params},
    ).fetchall()
    base: dict[str, int] = {r.namespace: int(r.base_kb) for r in base_rows}

    insert_sql = text("""
        INSERT INTO kb_stat_kb_creation_trend
            (run_id, target_date, stat_date, namespace, new_kb_count, cumulative_kb_count)
        VALUES (:run_id, :target_date, :stat_date, :ns, :new_kb, :cumulative_kb)
    """)
    days = [start + _td(days=i) for i in range((end - start).days + 1)]
    batch: list[dict] = []
    for ns in namespaces:
        cumulative = base.get(ns, 0)
        for d in days:
            cumulative += counts.get((d, ns), 0)
            batch.append(
                {
                    "run_id": run_id,
                    "target_date": mfilter.target_date,
                    "stat_date": d,
                    "ns": ns,
                    "new_kb": counts.get((d, ns), 0),
                    "cumulative_kb": cumulative,
                }
            )
    if batch:
        stat_session.execute(insert_sql, batch)
    return len(batch)


# ---------------------------------------------------------------------------
# 2. kb_activity
# ---------------------------------------------------------------------------


@register_collector(
    domain="deep_analysis",
    description="Per-KB activity snapshot (cross-section)",
    chart_hint="table",
)
def kb_activity(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND k.id {kb_clause}" if kb_clause else ""

    kb_meta = fetch_kb_metadata(source_session, mfilter.kb_ids)

    rows = source_session.execute(
        text(f"""
            SELECT k.id AS kb_id,
                   COUNT(DISTINCT kd.id) AS doc_count,
                   MAX(kd.created_at) AS last_doc_upload,
                   MAX(sc.created_at) AS last_query
            FROM kinds k
            LEFT JOIN knowledge_documents kd
                ON kd.kind_id = k.id AND kd.is_active = 1
            LEFT JOIN subtask_contexts sc
                ON sc.context_type = 'knowledge_base'
                AND JSON_EXTRACT(sc.type_data, '$.knowledge_id') = k.id
            WHERE k.kind = 'KnowledgeBase' AND k.is_active = 1
              {kb_filter_sql}
            GROUP BY k.id
        """),
        kb_params,
    ).fetchall()

    stale_cutoff = mfilter.target_date - timedelta(days=STALE_THRESHOLD_DAYS)
    inactive_cutoff = mfilter.target_date - timedelta(days=INACTIVE_THRESHOLD_DAYS)

    written = 0
    for r in rows:
        ns, name = kb_meta.get(r.kb_id, ("", ""))
        is_stale = (
            1 if (r.last_doc_upload and r.last_doc_upload.date() < stale_cutoff) else 0
        )
        is_inactive = (
            1 if (r.last_query and r.last_query.date() < inactive_cutoff) else 0
        )

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_kb_activity
                    (run_id, target_date, kb_id, kb_namespace, kb_name,
                     document_count, last_doc_uploaded_at, last_query_at,
                     is_stale, is_inactive)
                VALUES (:run_id, :target_date, :kb_id, :ns, :name,
                        :doc_count, :last_doc, :last_query,
                        :is_stale, :is_inactive)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "ns": ns,
                "name": name,
                "doc_count": r.doc_count,
                "last_doc": r.last_doc_upload,
                "last_query": r.last_query,
                "is_stale": is_stale,
                "is_inactive": is_inactive,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 3. kb_topic_distribution
# ---------------------------------------------------------------------------


@register_collector(
    domain="kb_lifecycle",
    name="kb_topic_distribution",
    description="KB topic label distribution",
    chart_hint="pie",
)
def kb_topic_distribution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT id, json
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_filter_sql}
        """),
        kb_params,
    ).fetchall()

    # Parse JSON to extract spec.summary.topics and count KBs per topic
    topic_counter: Counter[str] = Counter()
    for r in rows:
        try:
            spec = json.loads(r.json) if r.json else {}
            topics = spec.get("spec", {}).get("summary", {}).get("topics", [])
        except (json.JSONDecodeError, AttributeError, TypeError):
            topics = []

        if topics:
            for topic in topics:
                topic_counter[str(topic)] += 1
        else:
            topic_counter["(unlabeled)"] += 1

    written = 0
    for topic, count in topic_counter.items():
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_kb_topic_distribution
                    (run_id, target_date, topic, kb_count)
                VALUES (:run_id, :target_date, :topic, :kb_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "topic": topic,
                "kb_count": count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 4. kb_retrieval_config
# ---------------------------------------------------------------------------


@register_collector(
    domain="kb_lifecycle",
    name="kb_retrieval_config",
    description="KB retrieval config preference distribution",
    chart_hint="table",
)
def kb_retrieval_config(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT id, json
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_filter_sql}
        """),
        kb_params,
    ).fetchall()

    # Parse JSON to extract spec.retrievalConfig and group by config combo
    config_counter: Counter[tuple] = Counter()
    for r in rows:
        try:
            spec = json.loads(r.json) if r.json else {}
            rc = spec.get("spec", {}).get("retrievalConfig", {})
        except (json.JSONDecodeError, AttributeError, TypeError):
            rc = {}

        retrieval_mode = str(rc.get("retrieval_mode", "default"))
        top_k = rc.get("top_k", 5) if rc.get("top_k") is not None else 5
        score_threshold = (
            rc.get("score_threshold", 0.5)
            if rc.get("score_threshold") is not None
            else 0.5
        )
        config_counter[(retrieval_mode, top_k, score_threshold)] += 1

    written = 0
    for (retrieval_mode, top_k, score_threshold), count in config_counter.items():
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_kb_retrieval_config
                    (run_id, target_date, retrieval_mode, top_k,
                     score_threshold, kb_count)
                VALUES (:run_id, :target_date, :retrieval_mode, :top_k,
                        :score_threshold, :kb_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "retrieval_mode": retrieval_mode,
                "top_k": top_k,
                "score_threshold": score_threshold,
                "kb_count": count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 5. kb_size_distribution
# ---------------------------------------------------------------------------


@register_collector(
    domain="kb_lifecycle",
    name="kb_size_distribution",
    description="Per-KB size distribution with bucket logic",
    chart_hint="line",
)
def kb_size_distribution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB daily size distribution.

    For each day in the lookback window, counts documents that existed up to
    and including that day (created_at <= day), giving a cumulative growth
    trend rather than a single cross-section snapshot.
    """
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND kd.kind_id {kb_clause}" if kb_clause else ""
    # kinds-side filter uses the same kb params (id == kind_id).
    kb_filter_sql_kinds = f"AND k.id {kb_clause}" if kb_clause else ""

    start = mfilter.effective_period_start
    end = mfilter.period_end_date

    # Generate the list of days we need to compute for.
    days = []
    d = start
    while d <= end:
        days.append(d)
        d += timedelta(days=1)

    kb_meta = fetch_kb_metadata(source_session, mfilter.kb_ids)
    written = 0
    insert_sql = text("""
        INSERT INTO kb_stat_kb_size_distribution
            (run_id, target_date, stat_date, kb_id, kb_name, namespace,
             doc_count, total_file_size, avg_file_size,
             max_file_size, size_bucket)
        VALUES (:run_id, :target_date, :stat_date, :kb_id, :kb_name, :namespace,
                :doc_count, :total_file_size, :avg_file_size,
                :max_file_size, :size_bucket)
        """)

    # Cumulative-growth via "base snapshot + daily increments" instead of a
    # per-day full rescan. The previous loop ran ``len(days)`` (default 30)
    # LEFT JOINs over knowledge_documents with ``created_at <= :cutoff``, each
    # rescanning a monotonically growing slice — O(days * total_docs) on the
    # business DB. Only created_at and file_size participate, both immutable
    # after document creation, so base + running increments reproduce the exact
    # same per-day cumulative values in two bounded scans. Mirrors the pattern
    # already used by kb_growth_curve / kb_creation_trend in this module.

    # Scan 1: base cumulative per-KB snapshot for documents created strictly
    # before the window start (doc_count, sum & max of file_size).
    base_rows = source_session.execute(
        text(f"""
            SELECT kd.kind_id AS kb_id,
                   COUNT(*) AS base_doc_count,
                   COALESCE(SUM(kd.file_size), 0) AS base_total_size,
                   MAX(kd.file_size) AS base_max_size
            FROM knowledge_documents kd
            WHERE kd.is_active = 1
              AND kd.created_at < :start_date
              {kb_filter_sql}
            GROUP BY kd.kind_id
        """),
        {"start_date": start, **kb_params},
    ).fetchall()
    base_by_kb: dict[int, tuple[int, int, int]] = {}
    for r in base_rows:
        base_by_kb[int(r.kb_id)] = (
            int(r.base_doc_count or 0),
            int(r.base_total_size or 0),
            int(r.base_max_size) if r.base_max_size is not None else 0,
        )

    # Scan 2: daily per-KB increments inside the window.
    incr_rows = source_session.execute(
        text(f"""
            SELECT DATE(kd.created_at) AS d,
                   kd.kind_id AS kb_id,
                   COUNT(*) AS day_doc_count,
                   COALESCE(SUM(kd.file_size), 0) AS day_total_size,
                   MAX(kd.file_size) AS day_max_size
            FROM knowledge_documents kd
            WHERE kd.is_active = 1
              AND kd.created_at >= :start_date
              AND kd.created_at <= :end_date
              {kb_filter_sql}
            GROUP BY DATE(kd.created_at), kd.kind_id
        """),
        {"start_date": start, "end_date": end, **kb_params},
    ).fetchall()
    incr_by_kb_day: dict[tuple, tuple[int, int, int]] = {}
    for r in incr_rows:
        incr_by_kb_day[(int(r.kb_id), r.d)] = (
            int(r.day_doc_count or 0),
            int(r.day_total_size or 0),
            int(r.day_max_size) if r.day_max_size is not None else 0,
        )

    # Scan 3: KB identity (id/name/namespace) — once. Only KBs created on or
    # before ``end`` can have documents in the window, so this bounds the
    # emitted rows the same way the original ``k.created_at <= :cutoff`` did.
    kb_identity_rows = source_session.execute(
        text(f"""
            SELECT id, name, namespace
            FROM kinds k
            WHERE k.kind = 'KnowledgeBase' AND k.is_active = 1
              AND k.created_at <= :cutoff
              {kb_filter_sql_kinds}
            """),
        {"cutoff": end, **kb_params},
    ).fetchall()

    # Accumulate per-KB running totals across the day series. A KB with no
    # documents on a given day still emits a row carrying its carried-forward
    # cumulative, matching the original gapless trend semantics.
    running: dict[int, list] = {}  # kb_id -> [doc_count, total_size, max_size]
    for kb_row in kb_identity_rows:
        kb_id = int(kb_row.id)
        base = base_by_kb.get(kb_id, (0, 0, 0))
        running[kb_id] = [base[0], base[1], base[2]]

    for stat_date in days:
        batch: list[dict] = []
        for kb_row in kb_identity_rows:
            kb_id = int(kb_row.id)
            inc = incr_by_kb_day.get((kb_id, stat_date))
            if inc is not None:
                running[kb_id][0] += inc[0]
                running[kb_id][1] += inc[1]
                if inc[2] > running[kb_id][2]:
                    running[kb_id][2] = inc[2]
            doc_count, total_size, max_size = running[kb_id]
            # Skip KBs with no documents up to this day — same no-data
            # semantics as the original (a 0-doc row adds no insight).
            if doc_count == 0:
                continue
            ns, name = kb_meta.get(kb_id, (kb_row.namespace, kb_row.name))
            avg_size = total_size // doc_count if doc_count else None
            batch.append(
                {
                    "run_id": run_id,
                    "target_date": mfilter.target_date,
                    "stat_date": stat_date,
                    "kb_id": kb_id,
                    "kb_name": name,
                    "namespace": ns,
                    "doc_count": doc_count,
                    "total_file_size": total_size,
                    "avg_file_size": avg_size,
                    "max_file_size": max_size if max_size else None,
                    "size_bucket": _size_bucket(total_size),
                }
            )
        if batch:
            stat_session.execute(insert_sql, batch)
            written += len(batch)
    return written


# ---------------------------------------------------------------------------
# 6. kb_abandon_rate
# ---------------------------------------------------------------------------


@register_collector(
    domain="kb_lifecycle",
    name="kb_abandon_rate",
    description="KB abandon rate by namespace per day",
    chart_hint="line",
)
def kb_abandon_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-namespace per-day KB abandon rate.

    .. note::

        This collector keeps a per-day query loop by design. The stale /
        inactive classification depends on each KB's document ``MAX(updated_at)``
        — a non-monotonic value that changes whenever a document is re-indexed
        or edited. "Base snapshot + daily increment" re-accumulation cannot
        reproduce the per-day cumulative freshness, so a daily rescan is
        required for correctness. Each query is bounded by
        ``kinds.created_at <= :cutoff``; keep
        ``knowledge_documents(kind_id, is_active, updated_at)`` indexed so the
        per-KB ``MAX(updated_at)`` subquery stays cheap. See
        ``kb_size_distribution`` for the increment-based pattern (applicable
        only where inputs are immutable after creation).
    """
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND k.id {kb_clause}" if kb_clause else ""

    start = mfilter.effective_period_start
    end = mfilter.period_end_date
    from datetime import timedelta as _td

    written = 0
    insert_sql = text("""
        INSERT INTO kb_stat_kb_abandon_rate
            (run_id, target_date, stat_date, namespace, total_kb_count,
             stale_kb_count, inactive_kb_count, abandon_rate)
        VALUES (:run_id, :target_date, :stat_date, :namespace, :total_kb_count,
                :stale_kb_count, :inactive_kb_count, :abandon_rate)
        """)
    d = start
    while d <= end:
        stale_cutoff = d - _td(days=STALE_THRESHOLD_DAYS)
        inactive_cutoff = d - _td(days=INACTIVE_THRESHOLD_DAYS)

        rows = source_session.execute(
            text(f"""
                SELECT k.namespace,
                       COUNT(DISTINCT k.id) AS total_kb,
                       SUM(CASE WHEN kd_last.last_update < :stale_cutoff THEN 1 ELSE 0 END)
                           AS stale_kb,
                       SUM(CASE WHEN kd_last.last_update < :inactive_cutoff THEN 1 ELSE 0 END)
                           AS inactive_kb
                FROM kinds k
                LEFT JOIN (
                    SELECT kind_id, MAX(updated_at) AS last_update
                    FROM knowledge_documents
                    WHERE is_active = 1
                    GROUP BY kind_id
                ) kd_last ON kd_last.kind_id = k.id
                WHERE k.kind = 'KnowledgeBase' AND k.is_active = 1
                  AND k.created_at <= :cutoff
                  {kb_filter_sql}
                GROUP BY k.namespace
            """),
            {
                "stale_cutoff": stale_cutoff,
                "inactive_cutoff": inactive_cutoff,
                "cutoff": d,
                **kb_params,
            },
        ).fetchall()

        # Batch the per-day INSERTs into one executemany.
        batch: list[dict] = []
        for r in rows:
            total = int(r.total_kb or 0)
            stale = int(r.stale_kb or 0)
            inactive = int(r.inactive_kb or 0)
            # Return None (not 0.0) when there are no KBs: 0.0 would read as
            # "0% abandonment — healthy", masking the fact that there is no
            # data. All other ratio collectors use None for the empty case.
            abandon_rate = round(stale / total * 100, 2) if total > 0 else None
            batch.append(
                {
                    "run_id": run_id,
                    "target_date": mfilter.target_date,
                    "stat_date": d,
                    "namespace": r.namespace,
                    "total_kb_count": total,
                    "stale_kb_count": stale,
                    "inactive_kb_count": inactive,
                    "abandon_rate": abandon_rate,
                }
            )
        if batch:
            stat_session.execute(insert_sql, batch)
            written += len(batch)
        d += _td(days=1)
    return written


# ---------------------------------------------------------------------------
# 7. kb_sharing
# ---------------------------------------------------------------------------


@register_collector(
    domain="collaboration",
    name="kb_sharing",
    description="Per-KB sharing degree with role breakdown",
    chart_hint="table",
)
def kb_sharing(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND k.id {kb_clause}" if kb_clause else ""

    kb_meta = fetch_kb_metadata(source_session, mfilter.kb_ids)

    # Query 1: member counts with role breakdown
    member_rows = source_session.execute(
        text(f"""
            SELECT k.id AS kb_id,
                   COUNT(rm.user_id) AS member_count,
                   SUM(CASE WHEN rm.role = 'Owner' THEN 1 ELSE 0 END) AS owner_count,
                   SUM(CASE WHEN rm.role = 'Maintainer' THEN 1 ELSE 0 END) AS maintainer_count,
                   SUM(CASE WHEN rm.role = 'Developer' THEN 1 ELSE 0 END) AS developer_count,
                   SUM(CASE WHEN rm.role = 'Reporter' THEN 1 ELSE 0 END) AS reporter_count,
                   SUM(CASE WHEN rm.role = 'RestrictedAnalyst' THEN 1 ELSE 0 END)
                       AS restricted_analyst_count
            FROM kinds k
            LEFT JOIN resource_members rm
                ON rm.resource_id = k.id
                AND rm.resource_type = 'KnowledgeBase'
            WHERE k.kind = 'KnowledgeBase' AND k.is_active = 1
              {kb_filter_sql}
            GROUP BY k.id
        """),
        kb_params,
    ).fetchall()

    # Query 2: share link counts
    share_rows = source_session.execute(
        text("""
            SELECT resource_id, COUNT(*) AS share_link_count
            FROM share_links
            WHERE resource_type = 'KnowledgeBase'
            GROUP BY resource_id
        """),
    ).fetchall()

    share_link_map: dict[int, int] = {
        r.resource_id: r.share_link_count for r in share_rows
    }

    written = 0
    for r in member_rows:
        _, name = kb_meta.get(r.kb_id, ("", ""))

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_kb_sharing
                    (run_id, target_date, kb_id, kb_name, member_count,
                     share_link_count, owner_count, maintainer_count,
                     developer_count, reporter_count, restricted_analyst_count)
                VALUES (:run_id, :target_date, :kb_id, :kb_name, :member_count,
                        :share_link_count, :owner_count, :maintainer_count,
                        :developer_count, :reporter_count, :restricted_analyst_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "kb_name": name,
                "member_count": r.member_count or 0,
                "share_link_count": share_link_map.get(r.kb_id, 0),
                "owner_count": r.owner_count or 0,
                "maintainer_count": r.maintainer_count or 0,
                "developer_count": r.developer_count or 0,
                "reporter_count": r.reporter_count or 0,
                "restricted_analyst_count": r.restricted_analyst_count or 0,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 8. kb_config_sanity — KB retrieval config sanity check
# ---------------------------------------------------------------------------


@register_collector(
    domain="kb_lifecycle",
    name="kb_config_sanity",
    description="KB retrieval config sanity check (flags suspicious settings)",
    chart_hint="table",
)
def kb_config_sanity(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Flag KBs whose retrieval configuration is likely misconfigured.

    Detects: score_threshold=0 (no relevance filtering), top_k=1 (near-zero
    recall), top_k>10 (excessive), empty retrieval_mode (unset). Reads the
    config from kinds.json.spec.retrievalConfig, mirroring kb_retrieval_config.
    """
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT id, name, json
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_filter_sql}
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        try:
            spec = json.loads(r.json) if r.json else {}
            rc = spec.get("spec", {}).get("retrievalConfig", {})
        except (json.JSONDecodeError, AttributeError, TypeError):
            rc = {}

        retrieval_mode = rc.get("retrieval_mode")
        top_k = rc.get("top_k")
        score_threshold = rc.get("score_threshold")

        issues: list[tuple[str, str, object]] = []
        if score_threshold is not None and float(score_threshold) == 0:
            issues.append(
                (
                    "score_threshold_zero",
                    "相似度阈值为0,不进行相关性过滤",
                    score_threshold,
                )
            )
        if top_k is not None and int(top_k) == 1:
            issues.append(("top_k_too_low", "top_k=1,几乎无召回能力", top_k))
        if top_k is not None and int(top_k) > 10:
            issues.append(("top_k_too_high", "top_k>10,可能注入过多上下文", top_k))
        if not retrieval_mode:
            issues.append(("mode_unset", "未设置检索模式", retrieval_mode or ""))

        for issue_type, issue_detail, config_value in issues:
            stat_session.execute(
                text("""
                    INSERT INTO kb_stat_kb_config_sanity
                        (run_id, target_date, kb_id, kb_name,
                         issue_type, issue_detail, config_value)
                    VALUES (:run_id, :target_date, :kb_id, :kb_name,
                            :issue_type, :issue_detail, :config_value)
                """),
                {
                    "run_id": run_id,
                    "target_date": mfilter.target_date,
                    "kb_id": r.id,
                    "kb_name": r.name,
                    "issue_type": issue_type,
                    "issue_detail": issue_detail,
                    "config_value": str(config_value),
                },
            )
            written += 1
    return written
