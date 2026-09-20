"""Narrow reads for the recent-agent picker."""

from sqlalchemy import exists
from sqlalchemy.orm import Query, Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.stores.tasks.interfaces import RecentTaskTeamRef
from shared.telemetry.decorators import trace_sync


def recent_owner_only_query(
    db: Session,
    model: type,
    *,
    user_id: int,
    limit: int,
    client_origin: str | None = None,
) -> Query:
    approved_member_exists = exists().where(
        ResourceMember.resource_type == ResourceType.TASK,
        ResourceMember.resource_id == model.id,
        ResourceMember.status == MemberStatus.APPROVED,
    )
    query = db.query(model).filter(
        model.kind == "Task",
        model.user_id == user_id,
        model.is_active == TaskResource.STATE_ACTIVE,
        model.is_group_chat.is_(False),
        ~approved_member_exists,
    )
    if client_origin:
        query = query.filter(model.client_origin == client_origin)
    return query.order_by(model.updated_at.desc(), model.id.desc()).limit(limit)


@trace_sync("list_recent_task_team_refs", "tasks.store")
def list_recent_task_team_refs(
    db: Session,
    model: type,
    *,
    user_id: int,
    limit: int,
) -> list[RecentTaskTeamRef]:
    if limit <= 0:
        return []
    query = recent_owner_only_query(db, model, user_id=user_id, limit=limit)
    rows = query.with_entities(
        model.json[("metadata", "labels", "taskType")],
        model.json[("spec", "teamRef")],
    ).all()
    return [RecentTaskTeamRef(row[0], row[1]) for row in rows]
