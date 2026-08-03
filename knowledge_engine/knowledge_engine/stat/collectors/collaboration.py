# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Collaboration domain collectors."""

import logging
from collections import defaultdict

from sqlalchemy import text
from sqlalchemy.orm import Session

from knowledge_engine.stat.filters import MetricFilter, build_kb_in_clause
from knowledge_engine.stat.registry import register_collector

logger = logging.getLogger(__name__)

# Filter out zero/epoch timestamps (e.g. legacy '0000-00-00' rows) in
# resource_members.reviewed_at before computing approval latency.
_EPOCH_SENTINEL = "1970-01-02"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _member_scale_bucket(count: int) -> str:
    """Classify member count into a human-readable bucket."""
    if count <= 1:
        return "个人(1)"
    if count <= 5:
        return "小型(2-5)"
    if count <= 15:
        return "中型(6-15)"
    if count <= 50:
        return "大型(16-50)"
    return "组织(>50)"


# ---------------------------------------------------------------------------
# 1. kb_member_scale
# ---------------------------------------------------------------------------


@register_collector(
    domain="collaboration",
    name="kb_member_scale",
    description="KB member scale distribution (bucketed)",
    chart_hint="pie",
)
def kb_member_scale(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND resource_id {kb_clause}" if kb_clause else ""

    # Query 1: member counts per KB
    member_rows = source_session.execute(
        text(f"""
            SELECT resource_id AS kb_id,
                   COUNT(DISTINCT user_id) AS member_count
            FROM resource_members
            WHERE resource_type = 'KnowledgeBase'
              {kb_where}
            GROUP BY resource_id
        """),
        kb_params,
    ).fetchall()

    member_map: dict[int, int] = {r.kb_id: r.member_count for r in member_rows}

    # Query 2: all active KBs (to include those with no members)
    kb_filter_sql = f"AND id {kb_clause}" if kb_clause else ""
    kb_rows = source_session.execute(
        text(f"""
            SELECT id
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_filter_sql}
        """),
        kb_params,
    ).fetchall()

    # Bucket distribution
    bucket_counter: dict[str, int] = defaultdict(int)
    for r in kb_rows:
        count = member_map.get(r.id, 0)
        bucket = _member_scale_bucket(count)
        bucket_counter[bucket] += 1

    written = 0
    for bucket, kb_count in bucket_counter.items():
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_kb_member_scale
                    (run_id, target_date, scale_bucket, kb_count)
                VALUES (:run_id, :target_date, :scale_bucket, :kb_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "scale_bucket": bucket,
                "kb_count": kb_count,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 2. invitation_chain
# ---------------------------------------------------------------------------


@register_collector(
    domain="collaboration",
    name="invitation_chain",
    description="Invitation chain analysis (top 200)",
    chart_hint="table",
)
def invitation_chain(
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
            SELECT invited_by_user_id AS inviter_id,
                   user_id AS invitee_id,
                   role,
                   resource_id AS kb_id
            FROM resource_members
            WHERE resource_type = 'KnowledgeBase'
              AND invited_by_user_id IS NOT NULL
              AND invited_by_user_id > 0
              {kb_where}
            ORDER BY id DESC
            LIMIT 200
        """),
        kb_params,
    ).fetchall()

    # Fetch user names for display (may not be accessible)
    user_name_map: dict[int, str] = {}
    try:
        user_rows = source_session.execute(
            text("SELECT id, user_name FROM users")
        ).fetchall()
        user_name_map = {r.id: r.user_name for r in user_rows}
    except Exception:
        logger.warning("Could not fetch user names for invitation_chain")

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_invitation_chain
                    (run_id, target_date, inviter_id, inviter_name,
                     invitee_id, invitee_name, role, kb_id)
                VALUES (:run_id, :target_date, :inviter_id, :inviter_name,
                        :invitee_id, :invitee_name, :role, :kb_id)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "inviter_id": r.inviter_id,
                "inviter_name": user_name_map.get(r.inviter_id, ""),
                "invitee_id": r.invitee_id,
                "invitee_name": user_name_map.get(r.invitee_id, ""),
                "role": r.role,
                "kb_id": r.kb_id,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 3. share_link_usage
# ---------------------------------------------------------------------------


@register_collector(
    domain="collaboration",
    name="share_link_usage",
    description="Share link usage per KB",
    chart_hint="table",
)
def share_link_usage(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND sl.resource_id {kb_clause}" if kb_clause else ""

    # Query 1: link count per KB
    link_rows = source_session.execute(
        text(f"""
            SELECT sl.resource_id AS kb_id,
                   COUNT(sl.id) AS link_count
            FROM share_links sl
            WHERE sl.resource_type = 'KnowledgeBase'
              {kb_where}
            GROUP BY sl.resource_id
        """),
        kb_params,
    ).fetchall()

    link_count_map: dict[int, int] = {r.kb_id: r.link_count for r in link_rows}

    # Query 2: join count per share link
    join_rows = source_session.execute(
        text("""
            SELECT share_link_id, COUNT(*) AS total_joins
            FROM resource_members
            WHERE share_link_id IS NOT NULL
              AND resource_type = 'KnowledgeBase'
            GROUP BY share_link_id
        """),
    ).fetchall()

    # Query 3: map share_link_id -> resource_id (kb_id)
    sl_rows = source_session.execute(
        text("""
            SELECT id, resource_id
            FROM share_links
            WHERE resource_type = 'KnowledgeBase'
        """),
    ).fetchall()

    sl_to_kb: dict[int, int] = {r.id: r.resource_id for r in sl_rows}

    # Aggregate joins per KB
    joins_per_kb: dict[int, int] = defaultdict(int)
    for r in join_rows:
        kb_id = sl_to_kb.get(r.share_link_id)
        if kb_id is not None:
            joins_per_kb[kb_id] += r.total_joins

    # Query 4: KB names
    kb_name_map: dict[int, str] = {}
    kb_filter_sql = f"AND id {kb_clause}" if kb_clause else ""
    kb_name_rows = source_session.execute(
        text(f"""
            SELECT id, name
            FROM kinds
            WHERE kind = 'KnowledgeBase' AND is_active = 1
              {kb_filter_sql}
        """),
        kb_params,
    ).fetchall()
    kb_name_map = {r.id: r.name for r in kb_name_rows}

    written = 0
    for kb_id in link_count_map:
        link_count = link_count_map[kb_id]
        total_joins = joins_per_kb.get(kb_id, 0)
        avg_joins_per_link = (
            round(total_joins / link_count, 2) if link_count > 0 else 0.0
        )

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_share_link_usage
                    (run_id, target_date, kb_id, kb_name,
                     link_count, total_joins, avg_joins_per_link)
                VALUES (:run_id, :target_date, :kb_id, :kb_name,
                        :link_count, :total_joins, :avg_joins_per_link)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": kb_id,
                "kb_name": kb_name_map.get(kb_id, ""),
                "link_count": link_count,
                "total_joins": total_joins,
                "avg_joins_per_link": avg_joins_per_link,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 4. approval_efficiency
# ---------------------------------------------------------------------------


@register_collector(
    domain="collaboration",
    name="approval_efficiency",
    description="Approval efficiency per KB",
    chart_hint="table",
)
def approval_efficiency(
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
            SELECT resource_id AS kb_id,
                   AVG(TIMESTAMPDIFF(MINUTE, requested_at, reviewed_at)) AS avg_minutes,
                   COUNT(*) AS total_requests,
                   SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count
            FROM resource_members
            WHERE resource_type = 'KnowledgeBase'
              AND requested_at IS NOT NULL
              AND reviewed_at IS NOT NULL
              AND reviewed_at > {_EPOCH_SENTINEL!r}
              AND status IN ('approved', 'rejected')
              {kb_where}
            GROUP BY resource_id
            LIMIT 100
        """),
        kb_params,
    ).fetchall()

    if not rows:
        return 0

    written = 0
    for r in rows:
        total = int(r.total_requests or 0)
        approved = int(r.approved_count or 0)
        approval_rate = round(approved / total * 100, 2) if total > 0 else 0.0

        stat_session.execute(
            text("""
                INSERT INTO kb_stat_approval_efficiency
                    (run_id, target_date, kb_id, avg_approval_minutes,
                     total_requests, approved_count, approval_rate)
                VALUES (:run_id, :target_date, :kb_id, :avg_minutes,
                        :total_requests, :approved_count, :approval_rate)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "avg_minutes": (
                    round(float(r.avg_minutes), 2) if r.avg_minutes else None
                ),
                "total_requests": total,
                "approved_count": approved,
                "approval_rate": approval_rate,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 5. cross_org_access
# ---------------------------------------------------------------------------


@register_collector(
    domain="collaboration",
    name="cross_org_access",
    description="Cross-organization KB access",
    chart_hint="table",
)
def cross_org_access(
    run_id: int,
    mfilter: MetricFilter,
    *,
    source_session: Session,
    stat_session: Session,
) -> int:
    # Find users who are members of KBs in more than one namespace.
    # Since users lack a namespace column, we infer cross-org by checking
    # whether a single user_id appears in KBs belonging to different namespaces.
    # The cross-org user set is filtered server-side (HAVING COUNT(DISTINCT
    # namespace) > 1) so we only fetch the membership rows of cross-org users,
    # not the entire KB membership table — keeping Python-side memory bounded
    # by the cross-org slice rather than by total membership.
    kb_clause, kb_params = build_kb_in_clause(mfilter.kb_ids)
    kb_where = f"AND rm.resource_id {kb_clause}" if kb_clause else ""

    rows = source_session.execute(
        text(f"""
            SELECT rm.resource_id AS kb_id,
                   k.namespace AS kb_namespace,
                   k.name AS kb_name,
                   rm.user_id,
                   rm.role
            FROM resource_members rm
            JOIN kinds k
                ON k.id = rm.resource_id
                AND k.kind = 'KnowledgeBase'
                AND k.is_active = 1
            WHERE rm.resource_type = 'KnowledgeBase'
              AND rm.user_id IN (
                  SELECT rm2.user_id
                  FROM resource_members rm2
                  JOIN kinds k2
                      ON k2.id = rm2.resource_id
                      AND k2.kind = 'KnowledgeBase'
                      AND k2.is_active = 1
                  WHERE rm2.resource_type = 'KnowledgeBase'
                  GROUP BY rm2.user_id
                  HAVING COUNT(DISTINCT k2.namespace) > 1
              )
              {kb_where}
        """),
        kb_params,
    ).fetchall()

    written = 0
    for r in rows:
        stat_session.execute(
            text("""
                INSERT INTO kb_stat_cross_org_access
                    (run_id, target_date, kb_id, kb_namespace, kb_name,
                     user_id, user_namespace, role)
                VALUES (:run_id, :target_date, :kb_id, :kb_namespace, :kb_name,
                        :user_id, :user_namespace, :role)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "kb_id": r.kb_id,
                "kb_namespace": r.kb_namespace or "",
                "kb_name": r.kb_name,
                "user_id": r.user_id,
                "user_namespace": "",  # users table has no namespace
                "role": r.role,
            },
        )
        written += 1
    return written


# ---------------------------------------------------------------------------
# 6. permission_change_trend
# ---------------------------------------------------------------------------


@register_collector(
    domain="collaboration",
    name="permission_change_trend",
    description="Permission change trend over time",
    chart_hint="line",
)
def permission_change_trend(
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
            SELECT DATE(created_at) AS d,
                   role,
                   status,
                   COUNT(*) AS change_count
            FROM resource_members
            WHERE resource_type = 'KnowledgeBase'
              AND created_at >= DATE_SUB(:end_date, INTERVAL :days DAY)
              {kb_where}
            GROUP BY DATE(created_at), role, status
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
                INSERT INTO kb_stat_permission_change_trend
                    (run_id, target_date, stat_date, role, status, change_count)
                VALUES (:run_id, :target_date, :stat_date, :role, :status, :change_count)
            """),
            {
                "run_id": run_id,
                "target_date": mfilter.target_date,
                "stat_date": r.d,
                "role": r.role,
                "status": r.status,
                "change_count": r.change_count,
            },
        )
        written += 1
    return written
