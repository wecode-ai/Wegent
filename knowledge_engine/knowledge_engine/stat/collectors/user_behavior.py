# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User behavior domain collectors."""

import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector

logger = logging.getLogger(__name__)


def _fetch_user_names(
    source_session: Session, user_ids: Optional[set[int]] = None
) -> dict[int, str]:
    """Fetch user_id -> user_name mapping.

    When ``user_ids`` is given, only those users are queried (batched via
    ``build_kb_in_clause`` to avoid an over-long IN list); otherwise all
    users are read. The ``users`` table may not exist in the source database,
    so failures are handled gracefully and fall back to str(user_id).
    """
    try:
        if user_ids is not None:
            uid_list = list(user_ids)
            names: dict[int, str] = {}
            for start in range(0, len(uid_list), 500):
                batch = uid_list[start : start + 500]
                clause, params = build_kb_in_clause(batch, prefix="un")
                rows = source_session.execute(
                    text(f"SELECT id, user_name FROM users WHERE id {clause}"),
                    params,
                ).fetchall()
                for r in rows:
                    names[r.id] = r.user_name or ""
            return names
        rows = source_session.execute(
            text("SELECT id, user_name FROM users")
        ).fetchall()
        return {r.id: r.user_name for r in rows}
    except Exception:
        logger.debug("users table not accessible, falling back to user_id strings")
        return {}


@register_collector(
    domain="user_behavior",
    name="kb_creator_ranking",
    description="Top 100 KB creators",
    chart_hint="table",
)
def kb_creator_ranking(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT user_id, COUNT(*) AS kb_count
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_where}
            GROUP BY user_id
            ORDER BY kb_count DESC
            LIMIT 100
        """),
        kb_params,
    ).fetchall()

    user_names = _fetch_user_names(source_session)

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_kb_creator_ranking
                    (run_id, target_date, user_id, user_name, kb_count)
                VALUES (:run_id, :target_date, :user_id, :user_name, :kb_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "user_id": r.user_id,
                "user_name": user_names.get(r.user_id, str(r.user_id)),
                "kb_count": r.kb_count,
            },
        )
        written += 1
    return written


@register_collector(
    domain="user_behavior",
    name="doc_uploader_ranking",
    description="Top 100 document uploaders",
    chart_hint="table",
)
def doc_uploader_ranking(
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
            SELECT user_id, COUNT(*) AS upload_count
            FROM knowledge_documents
            WHERE is_active = 1
              {kb_where}
            GROUP BY user_id
            ORDER BY upload_count DESC
            LIMIT 100
        """),
        kb_params,
    ).fetchall()

    user_names = _fetch_user_names(source_session)

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_doc_uploader_ranking
                    (run_id, target_date, user_id, user_name, upload_count)
                VALUES (:run_id, :target_date, :user_id, :user_name, :upload_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "user_id": r.user_id,
                "user_name": user_names.get(r.user_id, str(r.user_id)),
                "upload_count": r.upload_count,
            },
        )
        written += 1
    return written


@register_collector(
    domain="user_behavior",
    name="retrieval_active_user",
    description="Top 100 active users with tier classification",
    chart_hint="table",
)
def retrieval_active_user(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    rows = source_session.execute(
        text("""
            SELECT sc.user_id,
                   SUM(CASE WHEN sc.type_data->'$.rag_result' IS NOT NULL THEN 1 ELSE 0 END)
                       AS rag_count,
                   SUM(CASE WHEN sc.type_data->'$.kb_head_result' IS NOT NULL THEN 1 ELSE 0 END)
                       AS head_count,
                   COUNT(*) AS total_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
            GROUP BY sc.user_id
            ORDER BY total_count DESC
            LIMIT 100
        """),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
        },
    ).fetchall()

    user_names = _fetch_user_names(source_session)

    written = 0
    for r in rows:
        total = int(r.total_count or 0)
        if total >= 50:
            tier = "heavy"
        elif total >= 10:
            tier = "moderate"
        else:
            tier = "casual"

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_retrieval_active_user
                    (run_id, target_date, user_id, user_name,
                     rag_count, head_count, total_count, user_tier)
                VALUES (:run_id, :target_date, :user_id, :user_name,
                        :rag_count, :head_count, :total_count, :user_tier)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "user_id": r.user_id,
                "user_name": user_names.get(r.user_id, str(r.user_id)),
                "rag_count": r.rag_count or 0,
                "head_count": r.head_count or 0,
                "total_count": total,
                "user_tier": tier,
            },
        )
        written += 1
    return written


@register_collector(
    domain="user_behavior",
    name="user_rag_head_preference",
    description="Per-user RAG vs head retrieval preference",
    chart_hint="table",
)
def user_rag_head_preference(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    rows = source_session.execute(
        text("""
            SELECT sc.user_id,
                   SUM(CASE WHEN sc.type_data->'$.rag_result' IS NOT NULL THEN 1 ELSE 0 END)
                       AS rag_count,
                   SUM(CASE WHEN sc.type_data->'$.kb_head_result' IS NOT NULL THEN 1 ELSE 0 END)
                       AS head_count,
                   COUNT(*) AS total_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
            GROUP BY sc.user_id
        """),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
        },
    ).fetchall()

    user_names = _fetch_user_names(source_session)

    written = 0
    for r in rows:
        total = int(r.total_count or 0)
        rag = int(r.rag_count or 0)
        head = int(r.head_count or 0)

        if total > 0 and rag / total > 0.7:
            preference = "rag"
        elif total > 0 and head / total > 0.7:
            preference = "head"
        else:
            preference = "balanced"

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_user_rag_head_preference
                    (run_id, target_date, user_id, user_name,
                     rag_count, head_count, preference)
                VALUES (:run_id, :target_date, :user_id, :user_name,
                        :rag_count, :head_count, :preference)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "user_id": r.user_id,
                "user_name": user_names.get(r.user_id, str(r.user_id)),
                "rag_count": rag,
                "head_count": head,
                "preference": preference,
            },
        )
        written += 1
    return written


@register_collector(
    domain="user_behavior",
    name="user_kb_binding",
    description="KB-task binding counts via JSON_TABLE",
    chart_hint="table",
)
def user_kb_binding(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    try:
        rows = source_session.execute(text("""
                SELECT jt.kb_id, COUNT(DISTINCT t.id) AS task_count
                FROM tasks t,
                     JSON_TABLE(t.json, '$.spec.knowledgeBaseRefs[*]'
                         COLUMNS (kb_id INTEGER PATH '$.id')
                     ) AS jt
                WHERE t.is_active = 1
                  AND jt.kb_id IS NOT NULL
                GROUP BY jt.kb_id
                ORDER BY task_count DESC
                LIMIT 100
            """)).fetchall()
    except Exception:
        logger.warning(
            "JSON_TABLE not supported or query failed, skipping user_kb_binding"
        )
        return 0

    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    if kb_clause:
        rows = [r for r in rows if r.kb_id in (mfilter.kb_ids or [])]

    # Fetch KB names for the bound kb_ids
    kb_names: dict[int, str] = {}
    if rows:
        kb_ids_needed = [r.kb_id for r in rows]
        kb_id_clause, kb_id_params = build_kb_in_clause(kb_ids_needed, prefix="bkb")
        try:
            kb_rows = source_session.execute(
                text(f"""
                    SELECT id, name FROM kinds
                    WHERE kind = 'KnowledgeBase' AND is_active = 1
                      AND id {kb_id_clause}
                """),
                kb_id_params,
            ).fetchall()
            kb_names = {r.id: r.name or "" for r in kb_rows}
        except Exception:
            logger.debug("Failed to fetch KB names for user_kb_binding")

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_user_kb_binding
                    (run_id, target_date, kb_id, kb_name, task_count)
                VALUES (:run_id, :target_date, :kb_id, :kb_name, :task_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "kb_name": kb_names.get(r.kb_id, str(r.kb_id)),
                "task_count": r.task_count,
            },
        )
        written += 1
    return written


@register_collector(
    domain="user_behavior",
    name="user_permission_distribution",
    description="Per-role user counts in KB resource members",
    chart_hint="pie",
)
def user_permission_distribution(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND resource_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT role, COUNT(DISTINCT user_id) AS user_count
            FROM resource_members
            WHERE resource_type = 'KnowledgeBase'
              {kb_where}
            GROUP BY role
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_user_permission_distribution
                    (run_id, target_date, role, user_count)
                VALUES (:run_id, :target_date, :role, :user_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "role": r.role,
                "user_count": r.user_count,
            },
        )
        written += 1
    return written


@register_collector(
    domain="user_behavior",
    name="restricted_analyst_usage",
    description="Per-KB RestrictedAnalyst user counts",
    chart_hint="table",
)
def restricted_analyst_usage(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND resource_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT resource_id AS kb_id, COUNT(DISTINCT user_id) AS analyst_count
            FROM resource_members
            WHERE role = 'RestrictedAnalyst'
              AND resource_type = 'KnowledgeBase'
              {kb_where}
            GROUP BY resource_id
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_restricted_analyst_usage
                    (run_id, target_date, kb_id, analyst_count)
                VALUES (:run_id, :target_date, :kb_id, :analyst_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "analyst_count": r.analyst_count,
            },
        )
        written += 1
    return written


@register_collector(
    domain="user_behavior",
    name="user_first_kb_usage",
    description="Days from registration to first KB usage (limit 200)",
    chart_hint="table",
)
def user_first_kb_usage(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    try:
        rows = source_session.execute(
            text("""
                SELECT u.id, u.user_name, u.created_at AS registered_at,
                       MIN(sc.created_at) AS first_kb_usage_at
                FROM users u
                LEFT JOIN subtask_contexts sc
                    ON sc.user_id = u.id AND sc.context_type = 'knowledge_base'
                WHERE u.created_at >= DATE_SUB(:end_date, INTERVAL 90 DAY)
                GROUP BY u.id, u.user_name, u.created_at
                HAVING first_kb_usage_at IS NOT NULL
                LIMIT 200
            """),
            {
                "end_date": mfilter.effective_end_date,
            },
        ).fetchall()
    except Exception:
        logger.warning("users table not accessible, skipping user_first_kb_usage")
        return 0

    written = 0
    for r in rows:
        days_to_first = None
        if r.registered_at and r.first_kb_usage_at:
            delta = r.first_kb_usage_at - r.registered_at
            days_to_first = delta.total_seconds() / 86400.0

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_user_first_kb_usage
                    (run_id, target_date, user_id, user_name,
                     registered_at, first_kb_usage_at, days_to_first)
                VALUES (:run_id, :target_date, :user_id, :user_name,
                        :registered_at, :first_kb_usage_at, :days_to_first)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "user_id": r.id,
                "user_name": r.user_name or str(r.id),
                "registered_at": r.registered_at,
                "first_kb_usage_at": r.first_kb_usage_at,
                "days_to_first": days_to_first,
            },
        )
        written += 1
    return written


@register_collector(
    domain="user_behavior",
    name="user_participation_summary",
    description="User participation type summary (limit 500)",
    chart_hint="table",
)
def user_participation_summary(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    # Gather per-user participation data from four sources. Each is a
    # cumulative "as-of target day" snapshot over currently-active resources:
    # only an exclusive end bound (created_at < effective_end_date) is
    # applied — no start bound, so historical participants keep their
    # identity. This keeps future-day data out of historical backfills.
    end_date = mfilter.effective_end_date
    creators: dict[int, int] = {}
    uploaders: dict[int, int] = {}
    retrievers: dict[int, int] = {}
    members: dict[int, int] = {}

    creator_rows = source_session.execute(
        text("""
            SELECT user_id, COUNT(*) AS cnt
            FROM kinds
            WHERE kind = 'KnowledgeBase'
              AND is_active = 1
              AND user_id IS NOT NULL
              AND created_at < :end_date
            GROUP BY user_id
        """),
        {"end_date": end_date},
    ).fetchall()
    for r in creator_rows:
        creators[r.user_id] = r.cnt

    uploader_rows = source_session.execute(
        text("""
            SELECT user_id, COUNT(*) AS cnt
            FROM knowledge_documents
            WHERE is_active = 1
              AND user_id IS NOT NULL
              AND created_at < :end_date
            GROUP BY user_id
        """),
        {"end_date": end_date},
    ).fetchall()
    for r in uploader_rows:
        uploaders[r.user_id] = r.cnt

    retriever_rows = source_session.execute(
        text("""
            SELECT user_id, COUNT(*) AS cnt
            FROM subtask_contexts
            WHERE context_type = 'knowledge_base'
              AND user_id IS NOT NULL
              AND created_at < :end_date
            GROUP BY user_id
        """),
        {"end_date": end_date},
    ).fetchall()
    for r in retriever_rows:
        retrievers[r.user_id] = r.cnt

    # Direct user members only: entity_type='user' excludes group/department
    # bindings (whose user_id=0 can't be attributed to a user). status=
    # 'approved' matches MemberStatus.APPROVED.value (collaboration.py uses
    # the same literal); knowledge_engine does not import backend models.
    member_rows = source_session.execute(
        text("""
            SELECT user_id, COUNT(*) AS cnt
            FROM resource_members
            WHERE resource_type = 'KnowledgeBase'
              AND entity_type = 'user'
              AND user_id IS NOT NULL
              AND status = 'approved'
              AND created_at < :end_date
            GROUP BY user_id
        """),
        {"end_date": end_date},
    ).fetchall()
    for r in member_rows:
        members[r.user_id] = r.cnt

    # Merge all user IDs
    all_user_ids = set(creators) | set(uploaders) | set(retrievers) | set(members)

    # Resolve names only for users that actually participate (not every user).
    user_names = _fetch_user_names(source_session, user_ids=all_user_ids)

    # Build participation records sorted by total activity descending
    participation_list = []
    for uid in all_user_ids:
        is_creator = 1 if uid in creators else 0
        is_uploader = 1 if uid in uploaders else 0
        is_retriever = 1 if uid in retrievers else 0
        is_member = 1 if uid in members else 0

        total = (
            creators.get(uid, 0)
            + uploaders.get(uid, 0)
            + retrievers.get(uid, 0)
            + members.get(uid, 0)
        )

        # Determine participation type based on roles
        roles = []
        if is_creator:
            roles.append("creator")
        if is_uploader:
            roles.append("uploader")
        if is_retriever:
            roles.append("retriever")
        if is_member:
            roles.append("member")
        participation_type = "+".join(roles) if roles else "none"

        participation_list.append(
            (
                uid,
                is_creator,
                is_uploader,
                is_retriever,
                is_member,
                participation_type,
                total,
            )
        )

    # Sort by total descending, then user_id ascending for stable ordering
    # when totals tie, and limit to 500.
    participation_list.sort(key=lambda x: (-x[6], x[0]))
    participation_list = participation_list[:500]

    written = 0
    for (
        uid,
        is_creator,
        is_uploader,
        is_retriever,
        is_member,
        ptype,
        _,
    ) in participation_list:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_user_participation_summary
                    (run_id, target_date, user_id, user_name,
                     is_creator, is_uploader, is_retriever, is_member,
                     participation_type)
                VALUES (:run_id, :target_date, :user_id, :user_name,
                        :is_creator, :is_uploader, :is_retriever, :is_member,
                        :participation_type)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "user_id": uid,
                "user_name": user_names.get(uid, str(uid)),
                "is_creator": is_creator,
                "is_uploader": is_uploader,
                "is_retriever": is_retriever,
                "is_member": is_member,
                "participation_type": ptype,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# P3: users who queried multiple KBs (signal for KB topology issues)
# ---------------------------------------------------------------------------


@register_collector(
    domain="user_behavior",
    name="cross_kb_query_user",
    description=(
        "Users who queried multiple different KBs in the period. A high "
        "count of cross-KB users suggests the KB topology may be split "
        "wrong — users have to hop between KBs to find answers."
    ),
    chart_hint="table",
)
def cross_kb_query_user(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    """Collect users who issued RAG/Head queries against >=2 distinct KBs."""
    # Note: this is a global metric, so we do not filter by kb_ids even
    # when mfilter.kb_ids is set — the point is cross-KB behavior, which
    # would be invisible if scoped to one KB.
    rows = source_session.execute(
        text("""
            SELECT sc.user_id AS user_id,
                   COUNT(DISTINCT JSON_EXTRACT(sc.type_data, '$.knowledge_id')) AS kb_count,
                   COUNT(*) AS query_count
            FROM subtask_contexts sc
            WHERE sc.context_type = 'knowledge_base'
              AND sc.user_id IS NOT NULL
              AND JSON_EXTRACT(sc.type_data, '$.knowledge_id') IS NOT NULL
              AND sc.created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              AND sc.created_at < :end_date
            GROUP BY sc.user_id
            HAVING kb_count >= 2
            ORDER BY kb_count DESC, query_count DESC
            LIMIT 500
        """),
        {
            "end_date": mfilter.effective_end_date,
            "days": mfilter.lookback_days,
        },
    ).fetchall()

    user_names = _fetch_user_names(source_session)

    written = 0
    for r in rows:
        uid = int(r.user_id or 0)
        if uid == 0:
            continue
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_cross_kb_query_user
                    (run_id, target_date, user_id, user_name,
                     kb_count, query_count)
                VALUES (:run_id, :target_date, :user_id, :user_name,
                        :kb_count, :query_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "user_id": uid,
                "user_name": user_names.get(uid, str(uid)),
                "kb_count": int(r.kb_count or 0),
                "query_count": int(r.query_count or 0),
            },
        )
        written += 1
    return written
