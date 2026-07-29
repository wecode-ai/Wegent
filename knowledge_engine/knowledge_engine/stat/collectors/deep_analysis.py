# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deep analysis domain collectors: health scores, rankings, and patterns."""

import json
import logging
import math
from collections import defaultdict
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector
from knowledge_engine.stat.source import fetch_kb_metadata

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 1. kb_health_score
# ---------------------------------------------------------------------------


@register_collector(
    domain="deep_analysis",
    name="kb_health_score",
    description="KB health score (weighted: activity 0.3, index_success 0.3, enable 0.2, summary 0.2)",
    chart_hint="radar",
)
def kb_health_score(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect per-KB per-day health score.

    For each day in the lookback window, computes health metrics based on
    documents that existed up to and including that day.

    .. note::

        This collector intentionally keeps a per-day query loop (one bounded
        scan per day). Unlike ``kb_size_distribution`` (whose only inputs are
        the immutable ``created_at`` / ``file_size`` columns), the health score
        reads *non-monotonic* document state — ``updated_at``, ``index_status``,
        ``is_active`` and ``summary`` all change over a document's lifetime.
        A "base snapshot + daily increment" re-accumulation cannot reproduce
        the per-day cumulative state from increments, so the daily rescan is
        required for semantic correctness. Each query is bounded by
        ``created_at <= :cutoff`` and the KB filter; ensure
        ``knowledge_documents(created_at, kind_id)`` is indexed to keep each
        daily scan cheap. Performance is tracked here rather than traded for
        an approximation that would silently skew health tiers.
    """
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND k.id {kb_clause}" if kb_clause else ""

    start = mfilter.effective_period_start
    end = mfilter.period_end_date

    from datetime import timedelta as _td

    written = 0
    insert_sql = text("""
        INSERT INTO kb_stat_kb_health_score
            (run_id, target_date, stat_date, kb_id, kb_name, namespace,
             activity_score, index_success_score, enable_score,
             summary_score, health_score, formula_version)
        VALUES (:run_id, :target_date, :stat_date, :kb_id, :kb_name, :namespace,
                :activity_score, :index_success_score, :enable_score,
                :summary_score, :health_score, :formula_version)
        """)
    d = start
    while d <= end:
        rows = source_session.execute(
            text(f"""
                SELECT k.id AS kb_id,
                       k.name AS kb_name,
                       k.namespace,
                       COUNT(kd.id) AS total_docs,
                       SUM(CASE WHEN kd.updated_at >= DATE_SUB(:cutoff, INTERVAL 30 DAY)
                            THEN 1 ELSE 0 END) AS active_docs,
                       SUM(CASE WHEN kd.index_status = 'success'
                            THEN 1 ELSE 0 END) AS success_docs,
                       SUM(CASE WHEN kd.is_active = 1
                            THEN 1 ELSE 0 END) AS enabled_docs,
                       SUM(CASE WHEN kd.summary IS NOT NULL AND JSON_LENGTH(kd.summary) > 0
                            THEN 1 ELSE 0 END) AS summary_docs
                FROM kinds k
                LEFT JOIN knowledge_documents kd
                    ON kd.kind_id = k.id AND kd.created_at <= :cutoff
                WHERE k.kind = 'KnowledgeBase' AND k.is_active = 1
                  AND k.created_at <= :cutoff
                  {kb_filter_sql}
                GROUP BY k.id, k.name, k.namespace
            """),
            {
                "cutoff": d,
                **kb_params,
            },
        ).fetchall()

        # Batch the per-day INSERTs: collect all KB rows for this day, then
        # issue a single executemany instead of N round-trips.
        batch: list[dict] = []
        for r in rows:
            total = int(r.total_docs or 0)
            # Skip empty KBs (no documents). Writing an all-NULL row would
            # pollute the ``no_data`` bucket of the health distribution
            # chart — ``no_data`` should mean "collection failed / not
            # covered", not "this KB genuinely has no documents". An empty
            # KB simply does not appear in the health-score tiers.
            if total == 0:
                continue
            activity_score = round(float(r.active_docs or 0) / total * 100, 2)
            index_success_score = round(float(r.success_docs or 0) / total * 100, 2)
            enable_score = round(float(r.enabled_docs or 0) / total * 100, 2)
            summary_score = round(float(r.summary_docs or 0) / total * 100, 2)

            health_score = round(
                activity_score * 0.3
                + index_success_score * 0.3
                + enable_score * 0.2
                + summary_score * 0.2,
                2,
            )
            batch.append(
                {
                    "run_id": run_id,
                    "target_date": mfilter.target_date,
                    "stat_date": d,
                    "kb_id": r.kb_id,
                    "kb_name": r.kb_name,
                    "namespace": r.namespace,
                    "activity_score": activity_score,
                    "index_success_score": index_success_score,
                    "enable_score": enable_score,
                    "summary_score": summary_score,
                    "health_score": health_score,
                    "formula_version": "v1",
                }
            )
        if batch:
            stat_session.execute(insert_sql, batch)
            written += len(batch)
        d += _td(days=1)
    return written


# ---------------------------------------------------------------------------
# 2. doc_value_ranking
# ---------------------------------------------------------------------------


@register_collector(
    domain="deep_analysis",
    name="doc_value_ranking",
    description="Top 200 doc value ranking by references and freshness",
    chart_hint="table",
)
def doc_value_ranking(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    # Query 1: fetch subtask_contexts to count rag/head references per doc
    ctx_rows = source_session.execute(
        text("""
            SELECT sc.type_data, sc.user_id
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
        """),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
        },
    ).fetchall()

    # Parse type_data to build reference counts per document
    rag_counts: dict[int, int] = defaultdict(int)
    head_counts: dict[int, int] = defaultdict(int)
    doc_users: dict[int, set] = defaultdict(set)

    for r in ctx_rows:
        try:
            data = json.loads(r.type_data) if r.type_data else {}
        except (json.JSONDecodeError, TypeError):
            continue

        # Count RAG references from rag_result.sources
        rag_result = data.get("rag_result")
        # user_id is a real column on subtask_contexts, not a JSON field —
        # reading it from type_data always returned None and dropped all
        # unique-user attribution.
        user_id = r.user_id

        if rag_result and isinstance(rag_result, dict):
            sources = rag_result.get("sources", [])
            if isinstance(sources, list):
                for src in sources:
                    doc_id = src.get("document_id") or src.get("doc_id")
                    if doc_id is not None:
                        try:
                            doc_id = int(doc_id)
                            rag_counts[doc_id] += 1
                            if user_id is not None:
                                doc_users[doc_id].add(user_id)
                        except (ValueError, TypeError):
                            pass

        # Count HEAD references from kb_head_result.document_ids
        head_result = data.get("kb_head_result")
        if head_result and isinstance(head_result, dict):
            doc_ids = head_result.get("document_ids", [])
            if isinstance(doc_ids, list):
                for doc_id in doc_ids:
                    try:
                        doc_id = int(doc_id)
                        head_counts[doc_id] += 1
                        if user_id is not None:
                            doc_users[doc_id].add(user_id)
                    except (ValueError, TypeError):
                        pass

    # Query 2: fetch only the docs that were actually referenced. The previous
    # implementation pulled *every* active document into Python just to score
    # and discard the vast majority as "no references" — that scaled with the
    # whole table (OOM risk) and ignored the per-KB backfill filter entirely.
    # Restrict to referenced ids AND push the KB filter down so per-KB runs do
    # not scan unrelated documents.
    referenced_ids = set(rag_counts) | set(head_counts)
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND kind_id {kb_clause}" if kb_clause else ""

    doc_rows: list = []
    if referenced_ids:
        did_clause, did_params = build_kb_in_clause(
            sorted(referenced_ids), prefix="did"
        )
        doc_rows = source_session.execute(
            text(f"""
                SELECT id, name, kind_id, updated_at
                FROM knowledge_documents
                WHERE is_active = 1
                  AND id {did_clause}
                  {kb_where}
            """),
            {**did_params, **kb_params},
        ).fetchall()

    # Build docs with value scores
    scored_docs = []
    end_dt = mfilter.period_end_date
    for r in doc_rows:
        rag = rag_counts.get(r.id, 0)
        head = head_counts.get(r.id, 0)
        unique_users = len(doc_users.get(r.id, set()))

        # Compute days since update
        if r.updated_at:
            if isinstance(r.updated_at, datetime):
                days_since = (end_dt - r.updated_at.date()).days
            else:
                days_since = (end_dt - r.updated_at).days
        else:
            days_since = mfilter.lookback_days

        value_score = (rag + head) * max(unique_users, 1) * math.exp(-days_since / 90.0)

        scored_docs.append(
            {
                "doc_id": r.id,
                "doc_name": r.name,
                "kb_id": r.kind_id,
                "rag_ref": rag,
                "head_ref": head,
                "unique_users": unique_users,
                "days_since_update": max(days_since, 0),
                "value_score": round(value_score, 4),
            }
        )

    # Sort by value_score desc, top 200
    scored_docs.sort(key=lambda d: d["value_score"], reverse=True)
    scored_docs = scored_docs[:200]

    written = 0
    for d in scored_docs:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_value_ranking
                    (run_id, target_date, document_id, document_name, kb_id,
                     rag_ref_count, head_ref_count, unique_users,
                     days_since_update, value_score)
                VALUES (:run_id, :target_date, :doc_id, :doc_name, :kb_id,
                        :rag_ref, :head_ref, :unique_users,
                        :days_since_update, :value_score)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "doc_id": d["doc_id"],
                "doc_name": d["doc_name"],
                "kb_id": d["kb_id"],
                "rag_ref": d["rag_ref"],
                "head_ref": d["head_ref"],
                "unique_users": d["unique_users"],
                "days_since_update": d["days_since_update"],
                "value_score": d["value_score"],
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 3. doc_lifecycle_trace
# ---------------------------------------------------------------------------


@register_collector(
    domain="deep_analysis",
    name="doc_lifecycle_trace",
    description="Top 200 docs by update time with lifecycle info",
    chart_hint="table",
)
def doc_lifecycle_trace(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND kind_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT id, name, kind_id AS kb_id, file_extension,
                   index_status, index_generation, file_size,
                   created_at, updated_at
            FROM knowledge_documents
            WHERE is_active = 1
              {kb_filter_sql}
            ORDER BY updated_at DESC
            LIMIT 200
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_lifecycle_trace
                    (run_id, target_date, document_id, document_name, kb_id,
                     file_extension, index_status, index_generation, file_size,
                     created_at_doc, updated_at_doc)
                VALUES (:run_id, :target_date, :doc_id, :doc_name, :kb_id,
                        :file_extension, :index_status, :index_generation, :file_size,
                        :created_at_doc, :updated_at_doc)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "doc_id": r.id,
                "doc_name": r.name,
                "kb_id": r.kb_id,
                "file_extension": r.file_extension,
                "index_status": r.index_status,
                "index_generation": r.index_generation or 1,
                "file_size": r.file_size or 0,
                "created_at_doc": r.created_at,
                "updated_at_doc": r.updated_at,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 5. user_pattern_evolution
# ---------------------------------------------------------------------------


@register_collector(
    domain="deep_analysis",
    name="user_pattern_evolution",
    description="Monthly per-user rag/head ratio evolution",
    chart_hint="table",
)
def user_pattern_evolution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    # Filter on the knowledge_id JSON field (same pattern as the
    # rag_head_co_occurrence collector below). Fixed 6-month trend snapshot:
    # [effective_end_date - 6 months, effective_end_date). The exclusive end
    # bound keeps future-day data out of historical backfills; the window is
    # independent of the daily beat's lookback_days=1 because each run emits
    # a full 6-month snapshot.
    kbf_clause, kbf_params = build_kb_in_clause(mfilter.kb_ids, prefix="kbf")
    kb_filter_sql = ""
    if kbf_clause:
        kb_filter_sql = "AND JSON_EXTRACT(sc.type_data, '$.knowledge_id') " + kbf_clause
    rows = source_session.execute(
        text(f"""
            SELECT sc.user_id,
                   DATE_FORMAT(sc.created_at, '%%Y-%%m') AS stat_month,
                   SUM(CASE WHEN sc.type_data->'$.rag_result' IS NOT NULL
                        THEN 1 ELSE 0 END) AS rag_count,
                   SUM(CASE WHEN sc.type_data->'$.kb_head_result' IS NOT NULL
                        THEN 1 ELSE 0 END) AS head_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL 6 MONTH)
              AND sc.created_at < :end_date
              AND sc.user_id IS NOT NULL
              {kb_filter_sql}
            GROUP BY sc.user_id, stat_month
            ORDER BY sc.user_id, stat_month
        """),
        {
            "end_date": mfilter.effective_end_date,
            **kbf_params,
        },
    ).fetchall()

    # Resolve user names for the users that actually appear in the result.
    # The users table is part of the business DB and may be inaccessible on
    # some deployments (e.g. a stripped read replica), so a failure here only
    # degrades the display (empty user_name) instead of failing the collector.
    # NB: SQLAlchemy ``text()`` does not expand a Python list into a bare
    # ``IN :name`` placeholder — that silently raised and left user_name empty.
    # Use the explicit expanding-placeholder builder shared by all collectors.
    user_names: dict[int, str] = {}
    user_ids = list({r.user_id for r in rows if r.user_id})
    if user_ids:
        uid_clause, uid_params = build_kb_in_clause(user_ids, prefix="un")
        try:
            user_rows = source_session.execute(
                text(f"SELECT id, user_name FROM users WHERE id {uid_clause}"),
                uid_params,
            ).fetchall()
            for ur in user_rows:
                user_names[ur.id] = ur.user_name or ""
        except Exception:
            logger.debug("Could not fetch user names from users table")

    written = 0
    for r in rows:
        rag = int(r.rag_count or 0)
        head = int(r.head_count or 0)
        total = rag + head
        rag_ratio = round(rag / total * 100, 2) if total > 0 else 0.0

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_user_pattern_evolution
                    (run_id, target_date, user_id, user_name,
                     stat_month, rag_count, head_count, rag_ratio)
                VALUES (:run_id, :target_date, :user_id, :user_name,
                        :stat_month, :rag_count, :head_count, :rag_ratio)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "user_id": r.user_id,
                "user_name": user_names.get(r.user_id, ""),
                "stat_month": r.stat_month,
                "rag_count": rag,
                "head_count": head,
                "rag_ratio": rag_ratio,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 6. kb_growth_curve
# ---------------------------------------------------------------------------


@register_collector(
    domain="deep_analysis",
    name="kb_growth_curve",
    description="Cumulative docs+members per KB per day",
    chart_hint="line",
)
def kb_growth_curve(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    start = mfilter.effective_period_start
    end = mfilter.effective_end_date

    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND kd.kind_id {kb_clause}" if kb_clause else ""
    kb_filter_sql2 = f"AND rm.resource_id {kb_clause}" if kb_clause else ""

    kb_meta = fetch_kb_metadata(source_session, mfilter.kb_ids)

    # SQL1: Daily new docs per KB
    doc_rows = source_session.execute(
        text(f"""
            SELECT DATE(kd.created_at) AS d,
                   kd.kind_id AS kb_id,
                   COUNT(*) AS new_docs
            FROM knowledge_documents kd
            WHERE kd.is_active = 1
              AND kd.created_at >= :start_date
              AND kd.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(kd.created_at), kd.kind_id
        """),
        {
            "start_date": start,
            "end_date": end,
            **kb_params,
        },
    ).fetchall()

    # SQL2: Daily new members per KB
    member_rows = source_session.execute(
        text(f"""
            SELECT DATE(rm.created_at) AS d,
                   rm.resource_id AS kb_id,
                   COUNT(*) AS new_members
            FROM resource_members rm
            WHERE rm.resource_type = 'KnowledgeBase'
              AND rm.created_at >= :start_date
              AND rm.created_at < :end_date
              {kb_filter_sql2}
            GROUP BY DATE(rm.created_at), rm.resource_id
        """),
        {
            "start_date": start,
            "end_date": end,
            **kb_params,
        },
    ).fetchall()

    # SQL3: Base cumulative counts (before period start)
    base_doc_rows = source_session.execute(
        text(f"""
            SELECT kd.kind_id AS kb_id, COUNT(*) AS base_docs
            FROM knowledge_documents kd
            WHERE kd.is_active = 1
              AND kd.created_at < :start_date
              {kb_filter_sql}
            GROUP BY kd.kind_id
        """),
        {
            "start_date": start,
            **kb_params,
        },
    ).fetchall()

    base_member_rows = source_session.execute(
        text(f"""
            SELECT rm.resource_id AS kb_id, COUNT(*) AS base_members
            FROM resource_members rm
            WHERE rm.resource_type = 'KnowledgeBase'
              AND rm.created_at < :start_date
              {kb_filter_sql2}
            GROUP BY rm.resource_id
        """),
        {
            "start_date": start,
            **kb_params,
        },
    ).fetchall()

    # Initialize base cumulative counts
    cumul_docs: dict[int, int] = {r.kb_id: r.base_docs for r in base_doc_rows}
    cumul_members: dict[int, int] = {r.kb_id: r.base_members for r in base_member_rows}

    # Build daily increment maps
    daily_docs: dict[tuple, int] = defaultdict(int)
    for r in doc_rows:
        daily_docs[(r.d, r.kb_id)] = r.new_docs

    daily_members: dict[tuple, int] = defaultdict(int)
    for r in member_rows:
        daily_members[(r.d, r.kb_id)] = r.new_members

    # Collect all (date, kb_id) combinations
    all_keys = set(daily_docs.keys()) | set(daily_members.keys())
    if not all_keys:
        return 0

    # Build per-KB date series and compute running cumulative totals
    kb_dates: dict[int, list] = defaultdict(list)
    for d, kb_id in all_keys:
        kb_dates[kb_id].append(d)

    written = 0
    for kb_id, dates in kb_dates.items():
        dates.sort()
        _, name = kb_meta.get(kb_id, ("", ""))

        # Initialize cumulative from base
        running_docs = cumul_docs.get(kb_id, 0)
        running_members = cumul_members.get(kb_id, 0)

        for d in dates:
            running_docs += daily_docs.get((d, kb_id), 0)
            running_members += daily_members.get((d, kb_id), 0)

            stat_session.execute(
                text("""
                    INSERT INTO kb_stat_kb_growth_curve
                        (run_id, target_date, kb_id, kb_name, stat_date,
                         cumulative_docs, cumulative_members)
                    VALUES (:run_id, :target_date, :kb_id, :kb_name, :stat_date,
                            :cumulative_docs, :cumulative_members)
                """),
                {
                    "run_id": run_id,
                    "target_date": mfilter.target_date,
                    "kb_id": kb_id,
                    "kb_name": name,
                    "stat_date": d,
                    "cumulative_docs": running_docs,
                    "cumulative_members": running_members,
                },
            )
            written += 1
    return written


# ---------------------------------------------------------------------------
# 7. rag_head_verify_rate
# ---------------------------------------------------------------------------


@register_collector(
    domain="deep_analysis",
    name="rag_head_verify_rate",
    description="RAG calls verified by head per day per KB",
    chart_hint="line",
)
def rag_head_verify_rate(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    start = mfilter.effective_period_start
    end = mfilter.effective_end_date

    # The filter targets the JSON field knowledge_id on subtask_contexts, so
    # use a dedicated prefixed clause (no raw id IN clause here, unlike
    # dashboard.py). Avoids the old `.replace("kb_", "kbf_")` hack that
    # renamed params in place.
    kbf_clause, kbf_params = build_kb_in_clause(mfilter.kb_ids, prefix="kbf")
    kb_filter_sql = ""
    if kbf_clause:
        kb_filter_sql = "AND JSON_EXTRACT(sc.type_data, '$.knowledge_id') " + kbf_clause

    rows = source_session.execute(
        text(f"""
            SELECT DATE(sc.created_at) AS d,
                   JSON_EXTRACT(sc.type_data, '$.knowledge_id') AS kb_id,
                   SUM(CASE WHEN sc.type_data->'$.rag_result' IS NOT NULL
                        THEN 1 ELSE 0 END) AS has_rag,
                   SUM(CASE WHEN sc.type_data->'$.rag_result' IS NOT NULL
                        AND sc.type_data->'$.kb_head_result' IS NOT NULL
                        THEN 1 ELSE 0 END) AS co_occur
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= :start_date
              AND sc.created_at < :end_date
              {kb_filter_sql}
            GROUP BY DATE(sc.created_at), JSON_EXTRACT(sc.type_data, '$.knowledge_id')
            ORDER BY d
        """),
        {
            "start_date": start,
            "end_date": end,
            **kbf_params,
        },
    ).fetchall()

    written = 0
    for r in rows:
        total_rag = int(r.has_rag or 0)
        # co_occur counts calls that have BOTH rag_result AND
        # kb_head_result — the true co-occurrence rate (capped at 100%).
        verified = int(r.co_occur or 0)
        verify_rate = round(verified / total_rag * 100, 2) if total_rag > 0 else 0.0

        # kb_id comes as JSON value, may be quoted string or integer
        kb_id = r.kb_id
        if isinstance(kb_id, str):
            try:
                kb_id = int(kb_id.strip('"'))
            except (ValueError, TypeError):
                pass

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_rag_head_verify_rate
                    (run_id, target_date, stat_date, kb_id,
                     total_rag_calls, verified_by_head, verify_rate)
                VALUES (:run_id, :target_date, :stat_date, :kb_id,
                        :total_rag_calls, :verified_by_head, :verify_rate)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "kb_id": kb_id,
                "total_rag_calls": total_rag,
                "verified_by_head": verified,
                "verify_rate": verify_rate,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 9. user_segmentation
# ---------------------------------------------------------------------------


@register_collector(
    domain="deep_analysis",
    name="user_segmentation",
    description="User segmentation counts by activity level",
    chart_hint="pie",
)
def user_segmentation(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    # SQL1: Creators — distinct users who created KnowledgeBases
    creator_count = (
        source_session.execute(
            text("""
            SELECT COUNT(DISTINCT user_id) AS cnt
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
        """),
        ).scalar()
        or 0
    )

    # SQL2: Active users — queried KB >= 10 times
    active_rows = source_session.execute(
        text("""
            SELECT COUNT(*) AS cnt FROM (
                SELECT user_id
                FROM subtask_contexts
                WHERE context_type = 'knowledge_base'
                GROUP BY user_id
                HAVING COUNT(*) >= 10
            ) AS active_users
        """),
    ).fetchone()
    active_count = active_rows.cnt if active_rows else 0

    # SQL3: Casual users — queried KB > 0 and < 10 times
    casual_rows = source_session.execute(
        text("""
            SELECT COUNT(*) AS cnt FROM (
                SELECT user_id
                FROM subtask_contexts
                WHERE context_type = 'knowledge_base'
                GROUP BY user_id
                HAVING COUNT(*) > 0 AND COUNT(*) < 10
            ) AS casual_users
        """),
    ).fetchone()
    casual_count = casual_rows.cnt if casual_rows else 0

    # SQL4: Observers — members with no operations (wrap in try/except)
    observer_count = 0
    try:
        observer_rows = source_session.execute(
            text("""
                SELECT COUNT(DISTINCT rm.user_id) AS cnt
                FROM resource_members rm
                WHERE rm.resource_type = 'KnowledgeBase'
                  AND rm.user_id NOT IN (
                      SELECT DISTINCT sc.user_id
                      FROM subtask_contexts sc
                      WHERE sc.context_type = 'knowledge_base'
                        AND sc.user_id IS NOT NULL
                  )
            """),
        ).fetchone()
        observer_count = observer_rows.cnt if observer_rows else 0
    except Exception:
        logger.debug("Could not compute observer count")

    segments = [
        ("creator", creator_count),
        ("active", active_count),
        ("casual", casual_count),
        ("observer", observer_count),
    ]

    written = 0
    for segment, count in segments:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_user_segmentation
                    (run_id, target_date, segment, user_count)
                VALUES (:run_id, :target_date, :segment, :user_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "segment": segment,
                "user_count": count,
            },
        )
        written += 1
    return written
