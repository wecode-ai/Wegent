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
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(
            f"""
            SELECT DATE(created_at) AS d, namespace,
                   COUNT(*) AS new_kb,
                   SUM(COUNT(*)) OVER (
                       PARTITION BY namespace
                       ORDER BY DATE(created_at)
                       ROWS UNBOUNDED PRECEDING
                   ) AS cumulative_kb
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              AND created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND created_at <= :end_date
              {kb_filter_sql}
            GROUP BY DATE(created_at), namespace
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
        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_creation_trend
                    (run_id, target_date, stat_date, namespace, new_kb_count, cumulative_kb_count)
                VALUES (:run_id, :target_date, :stat_date, :ns, :new_kb, :cumulative_kb)
            """
            ),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "ns": r.namespace,
                "new_kb": r.new_kb,
                "cumulative_kb": r.cumulative_kb,
            },
        )
        written += 1
    return written


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
        text(
            f"""
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
        """
        ),
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
            text(
                """
                INSERT INTO kb_stat_kb_activity
                    (run_id, target_date, kb_id, kb_namespace, kb_name,
                     document_count, last_doc_uploaded_at, last_query_at,
                     is_stale, is_inactive)
                VALUES (:run_id, :target_date, :kb_id, :ns, :name,
                        :doc_count, :last_doc, :last_query,
                        :is_stale, :is_inactive)
            """
            ),
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
        text(
            f"""
            SELECT id, json
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_filter_sql}
        """
        ),
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
            text(
                """
                INSERT INTO kb_stat_kb_topic_distribution
                    (run_id, target_date, topic, kb_count)
                VALUES (:run_id, :target_date, :topic, :kb_count)
            """
            ),
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
        text(
            f"""
            SELECT id, json
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_filter_sql}
        """
        ),
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
            text(
                """
                INSERT INTO kb_stat_kb_retrieval_config
                    (run_id, target_date, retrieval_mode, top_k,
                     score_threshold, kb_count)
                VALUES (:run_id, :target_date, :retrieval_mode, :top_k,
                        :score_threshold, :kb_count)
            """
            ),
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
    kb_filter_sql = f"AND k.id {kb_clause}" if kb_clause else ""

    start = mfilter.effective_period_start
    end = mfilter.effective_end_date

    # Generate the list of days we need to compute for.
    from datetime import timedelta as _td

    days = []
    d = start
    while d <= end:
        days.append(d)
        d += _td(days=1)

    kb_meta = fetch_kb_metadata(source_session, mfilter.kb_ids)
    written = 0

    for stat_date in days:
        rows = source_session.execute(
            text(
                f"""
                SELECT k.id AS kb_id,
                       k.name AS kb_name,
                       k.namespace,
                       COUNT(kd.id) AS doc_count,
                       COALESCE(SUM(kd.file_size), 0) AS total_file_size,
                       AVG(kd.file_size) AS avg_file_size,
                       MAX(kd.file_size) AS max_file_size
                FROM kinds k
                LEFT JOIN knowledge_documents kd
                    ON kd.kind_id = k.id AND kd.is_active = 1
                    AND kd.created_at <= :cutoff
                WHERE k.kind = 'KnowledgeBase' AND k.is_active = 1
                  AND k.created_at <= :cutoff
                  {kb_filter_sql}
                GROUP BY k.id, k.name, k.namespace
            """
            ),
            {"cutoff": stat_date, **kb_params},
        ).fetchall()

        for r in rows:
            ns, _ = kb_meta.get(r.kb_id, (r.namespace, r.kb_name))
            name = r.kb_name or kb_meta.get(r.kb_id, ("", ""))[1]
            total_size = int(r.total_file_size) if r.total_file_size else 0
            bucket = _size_bucket(total_size)

            stat_session.execute(
                text(
                    """
                    INSERT INTO kb_stat_kb_size_distribution
                        (run_id, target_date, stat_date, kb_id, kb_name, namespace,
                         doc_count, total_file_size, avg_file_size,
                         max_file_size, size_bucket)
                    VALUES (:run_id, :target_date, :stat_date, :kb_id, :kb_name, :namespace,
                            :doc_count, :total_file_size, :avg_file_size,
                            :max_file_size, :size_bucket)
                """
                ),
                {
                    "run_id": run_id,
                    "target_date": mfilter.target_date,
                    "stat_date": stat_date,
                    "kb_id": r.kb_id,
                    "kb_name": name,
                    "namespace": ns,
                    "doc_count": r.doc_count,
                    "total_file_size": total_size,
                    "avg_file_size": int(r.avg_file_size) if r.avg_file_size else None,
                    "max_file_size": int(r.max_file_size) if r.max_file_size else None,
                    "size_bucket": bucket,
                },
            )
            written += 1
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
    """Collect per-namespace per-day KB abandon rate."""
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_filter_sql = f"AND k.id {kb_clause}" if kb_clause else ""

    start = mfilter.effective_period_start
    end = mfilter.effective_end_date
    from datetime import timedelta as _td

    written = 0
    d = start
    while d <= end:
        stale_cutoff = d - _td(days=STALE_THRESHOLD_DAYS)
        inactive_cutoff = d - _td(days=INACTIVE_THRESHOLD_DAYS)

        rows = source_session.execute(
            text(
                f"""
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
            """
            ),
            {
                "stale_cutoff": stale_cutoff,
                "inactive_cutoff": inactive_cutoff,
                "cutoff": d,
                **kb_params,
            },
        ).fetchall()

        for r in rows:
            total = int(r.total_kb or 0)
            stale = int(r.stale_kb or 0)
            inactive = int(r.inactive_kb or 0)
            abandon_rate = round(stale / total * 100, 2) if total > 0 else 0.0

            stat_session.execute(
                text(
                    """
                    INSERT INTO kb_stat_kb_abandon_rate
                        (run_id, target_date, stat_date, namespace, total_kb_count,
                         stale_kb_count, inactive_kb_count, abandon_rate)
                    VALUES (:run_id, :target_date, :stat_date, :namespace, :total_kb_count,
                            :stale_kb_count, :inactive_kb_count, :abandon_rate)
                """
                ),
                {
                    "run_id": run_id,
                    "target_date": mfilter.target_date,
                    "stat_date": d,
                    "namespace": r.namespace,
                    "total_kb_count": total,
                    "stale_kb_count": stale,
                    "inactive_kb_count": inactive,
                    "abandon_rate": abandon_rate,
                },
            )
            written += 1
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
        text(
            f"""
            SELECT k.id AS kb_id,
                   COUNT(rm.user_id) AS member_count,
                   SUM(CASE WHEN rm.role = 'owner' THEN 1 ELSE 0 END) AS owner_count,
                   SUM(CASE WHEN rm.role = 'maintainer' THEN 1 ELSE 0 END) AS maintainer_count,
                   SUM(CASE WHEN rm.role = 'developer' THEN 1 ELSE 0 END) AS developer_count,
                   SUM(CASE WHEN rm.role = 'reporter' THEN 1 ELSE 0 END) AS reporter_count,
                   SUM(CASE WHEN rm.role = 'restricted_analyst' THEN 1 ELSE 0 END)
                       AS restricted_analyst_count
            FROM kinds k
            LEFT JOIN resource_members rm
                ON rm.resource_id = k.id
                AND rm.resource_type = 'KnowledgeBase'
            WHERE k.kind = 'KnowledgeBase' AND k.is_active = 1
              {kb_filter_sql}
            GROUP BY k.id
        """
        ),
        kb_params,
    ).fetchall()

    # Query 2: share link counts
    share_rows = source_session.execute(
        text(
            """
            SELECT resource_id, COUNT(*) AS share_link_count
            FROM share_links
            WHERE resource_type = 'KnowledgeBase'
            GROUP BY resource_id
        """
        ),
    ).fetchall()

    share_link_map: dict[int, int] = {
        r.resource_id: r.share_link_count for r in share_rows
    }

    written = 0
    for r in member_rows:
        _, name = kb_meta.get(r.kb_id, ("", ""))

        stat_session.execute(
            text(
                """
                INSERT INTO kb_stat_kb_sharing
                    (run_id, target_date, kb_id, kb_name, member_count,
                     share_link_count, owner_count, maintainer_count,
                     developer_count, reporter_count, restricted_analyst_count)
                VALUES (:run_id, :target_date, :kb_id, :kb_name, :member_count,
                        :share_link_count, :owner_count, :maintainer_count,
                        :developer_count, :reporter_count, :restricted_analyst_count)
            """
            ),
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
        text(
            f"""
            SELECT id, name, json
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_filter_sql}
        """
        ),
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
                text(
                    """
                    INSERT INTO kb_stat_kb_config_sanity
                        (run_id, target_date, kb_id, kb_name,
                         issue_type, issue_detail, config_value)
                    VALUES (:run_id, :target_date, :kb_id, :kb_name,
                            :issue_type, :issue_detail, :config_value)
                """
                ),
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
