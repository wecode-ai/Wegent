# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal agent usage reporting API."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, distinct, func, or_
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.kind import Kind
from app.models.user import User
from wecode.models.agent_task_usage import AgentTaskUsageDetail
from wecode.schemas.agent_usage import (
    AgentUsageAgent,
    AgentUsageAgentPage,
    AgentUsageDailyRow,
    AgentUsageQuery,
    AgentUsageResponse,
    AgentUsageRow,
)

router = APIRouter()
AUTHOR_QUERY_BATCH_SIZE = 500


def _get_author_names(db: Session, owner_ids: set[int]) -> dict[int, str]:
    author_names: dict[int, str] = {}
    sorted_owner_ids = sorted(owner_ids)
    for start in range(0, len(sorted_owner_ids), AUTHOR_QUERY_BATCH_SIZE):
        batch = sorted_owner_ids[start : start + AUTHOR_QUERY_BATCH_SIZE]
        author_names.update(
            db.query(User.id, User.user_name).filter(User.id.in_(batch)).all()
        )
    return author_names


@router.get("/agents", response_model=AgentUsageAgentPage)
def list_owned_agents(
    q: str = Query(default="", max_length=100),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AgentUsageAgentPage:
    filters = [Kind.kind == "Team", Kind.is_active.is_(True)]
    if current_user.role != "admin":
        filters.append(Kind.user_id == current_user.id)
    if q.strip():
        pattern = f"%{q.strip()}%"
        filters.append(
            or_(
                Kind.name.ilike(pattern),
                Kind.namespace.ilike(pattern),
                User.user_name.ilike(pattern),
            )
        )

    owned = (
        db.query(Kind.name, Kind.namespace, Kind.user_id, User.user_name)
        .outerjoin(User, User.id == Kind.user_id)
        .filter(*filters)
        .order_by(Kind.updated_at.desc())
        .offset(offset)
        .limit(limit + 1)
        .all()
    )
    has_more = len(owned) > limit
    items = [
        AgentUsageAgent(
            name=row.name,
            namespace=row.namespace,
            owner_user_id=row.user_id,
            author_name="Wegent" if row.user_id == 0 else (row.user_name or ""),
            is_owner=row.user_id == current_user.id,
        )
        for row in owned[:limit]
    ]
    return AgentUsageAgentPage(
        items=items,
        has_more=has_more,
        next_offset=offset + len(items),
    )


@router.post(
    "/query",
    response_model=AgentUsageResponse,
    response_model_exclude_none=True,
)
def query_usage(
    query: AgentUsageQuery,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AgentUsageResponse:
    if query.end_date < query.start_date:
        raise HTTPException(
            status_code=400, detail="end_date must not precede start_date"
        )
    if query.end_date >= date.today():
        raise HTTPException(
            status_code=400, detail="usage data is available through T-1 only"
        )
    if (query.end_date - query.start_date).days > 366:
        raise HTTPException(status_code=400, detail="date range cannot exceed 366 days")

    is_admin = current_user.role == "admin"
    requested_agents = query.agents
    requested_keys = {
        (agent.owner_user_id, agent.namespace, agent.name) for agent in requested_agents
    }
    requested_conditions = [
        and_(
            AgentTaskUsageDetail.agent_user_id == owner_user_id,
            AgentTaskUsageDetail.agent_namespace == namespace,
            AgentTaskUsageDetail.agent_name == name,
        )
        for owner_user_id, namespace, name in requested_keys
    ]
    if not is_admin and requested_agents:
        ownership_conditions = [
            and_(
                Kind.user_id == owner_user_id,
                Kind.namespace == namespace,
                Kind.name == name,
            )
            for owner_user_id, namespace, name in requested_keys
        ]
        owned_count = (
            db.query(Kind.id)
            .filter(
                Kind.user_id == current_user.id,
                Kind.kind == "Team",
                Kind.is_active.is_(True),
                or_(*ownership_conditions),
            )
            .count()
        )
        if owned_count != len(requested_keys):
            raise HTTPException(status_code=403, detail="Agent usage access denied")

    filters = [
        AgentTaskUsageDetail.task_created_at >= query.start_date,
        AgentTaskUsageDetail.task_created_at < query.end_date + timedelta(days=1),
    ]
    if not requested_agents:
        if not is_admin:
            filters.append(AgentTaskUsageDetail.agent_user_id == current_user.id)
    else:
        filters.append(or_(*requested_conditions))
    grouped = (
        db.query(
            AgentTaskUsageDetail.agent_name,
            AgentTaskUsageDetail.agent_namespace,
            AgentTaskUsageDetail.agent_user_id.label("owner_user_id"),
            func.count(AgentTaskUsageDetail.task_id).label("pv"),
            func.count(distinct(AgentTaskUsageDetail.visitor_user_id)).label("uv"),
            func.coalesce(func.sum(AgentTaskUsageDetail.ai_rounds), 0).label(
                "ai_rounds"
            ),
            func.coalesce(func.sum(AgentTaskUsageDetail.completed_ai_rounds), 0).label(
                "completed_ai_rounds"
            ),
        )
        .filter(*filters)
        .group_by(
            AgentTaskUsageDetail.agent_name,
            AgentTaskUsageDetail.agent_namespace,
            AgentTaskUsageDetail.agent_user_id,
        )
        .order_by(func.count(AgentTaskUsageDetail.task_id).desc())
        .all()
    )
    owner_ids = {row.owner_user_id for row in grouped if row.owner_user_id != 0}
    author_names = _get_author_names(db, owner_ids)
    rows = []
    for row in grouped:
        values = row._asdict()
        values["author_name"] = (
            "Wegent"
            if row.owner_user_id == 0
            else (author_names.get(row.owner_user_id) or "")
        )
        values.pop("owner_user_id")
        if not is_admin:
            values.pop("ai_rounds")
            values.pop("completed_ai_rounds")
        rows.append(AgentUsageRow(**values))
    if len(rows) <= 1:
        total_uv = rows[0].uv if rows else 0
    else:
        total_uv = (
            db.query(func.count(distinct(AgentTaskUsageDetail.visitor_user_id)))
            .filter(*filters)
            .scalar()
        )
    usage_date = func.date(AgentTaskUsageDetail.task_created_at).label("date")
    daily_grouped = (
        db.query(
            usage_date,
            AgentTaskUsageDetail.agent_name,
            AgentTaskUsageDetail.agent_namespace,
            func.count(AgentTaskUsageDetail.task_id).label("pv"),
            func.count(distinct(AgentTaskUsageDetail.visitor_user_id)).label("uv"),
            func.coalesce(func.sum(AgentTaskUsageDetail.ai_rounds), 0).label(
                "ai_rounds"
            ),
            func.coalesce(func.sum(AgentTaskUsageDetail.completed_ai_rounds), 0).label(
                "completed_ai_rounds"
            ),
        )
        .filter(*filters)
        .group_by(
            usage_date,
            AgentTaskUsageDetail.agent_name,
            AgentTaskUsageDetail.agent_namespace,
        )
        .order_by(
            usage_date.desc(),
            func.count(AgentTaskUsageDetail.task_id).desc(),
            AgentTaskUsageDetail.agent_name,
        )
        .all()
    )
    daily_rows = []
    for row in daily_grouped:
        values = row._asdict()
        if not is_admin:
            values.pop("ai_rounds")
            values.pop("completed_ai_rounds")
        daily_rows.append(AgentUsageDailyRow(**values))
    response = AgentUsageResponse(
        rows=rows,
        daily_rows=daily_rows,
        pv=sum(row.pv for row in rows),
        uv=int(total_uv or 0),
    )
    if is_admin:
        response.ai_rounds = sum(row.ai_rounds or 0 for row in rows)
        response.completed_ai_rounds = sum(row.completed_ai_rounds or 0 for row in rows)
    return response
