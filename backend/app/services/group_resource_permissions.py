"""Explicit resource consent for an actual chat group, without a fake Workspace."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CollaborationChatGroup, ProjectChatAgent
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.schemas.base_role import BaseRole
from app.services.chat_group_access import GROUP_RESOURCE_TYPE
from app.services.collaboration_container_access import (
    require_collaboration_container_access,
)
from app.services.collaboration_permissions import RESOURCE_USE_ROLES, resource_query
from app.services.resource_authority_reads import current_resource_authority
from app.services.resource_grant_storage import (
    ensure_resource_member_grant,
    resource_member_grant_candidate,
)


def _require_grant(db: Session, **identity: object) -> ResourceMember:
    grant = resource_query(
        db.query(ResourceMember).filter_by(**identity), current=True
    ).first()
    if (
        grant is None
        or grant.status != "approved"
        or grant.role not in RESOURCE_USE_ROLES
    ):
        raise HTTPException(
            422, "Agent resource authorization is revoked or unavailable"
        )
    return grant


def require_group_agent(
    db: Session, group: CollaborationChatGroup, agent: ProjectChatAgent
) -> None:
    _require_grant(
        db,
        resource_type=GROUP_RESOURCE_TYPE,
        resource_id=int(group.id),
        entity_type="project_agent",
        entity_id=agent.id,
    )


def share_group_agent(
    db: Session, group: CollaborationChatGroup, agent: ProjectChatAgent, user_id: int
) -> None:
    require_collaboration_container_access(
        db, group.id, user_id, BaseRole.Maintainer, write=True
    )
    values = dict(
        resource_type=GROUP_RESOURCE_TYPE,
        resource_id=int(group.id),
        entity_type="project_agent",
        entity_id=agent.id,
        added_by_user_id=user_id,
        role=BaseRole.Developer,
    )
    with resource_member_grant_candidate(db, **values) as existing:
        if existing.status == "approved" and existing.role in RESOURCE_USE_ROLES:
            return
        if agent.created_by_user_id != user_id:
            raise HTTPException(403, "Only the definition owner can share this Agent")
        ensure_resource_member_grant(db, **values)


def require_group_team(db: Session, group_id: str, team_id: int) -> Kind:
    team = resource_query(
        db.query(Kind).filter(Kind.id == team_id), current=True
    ).first()
    if team is None or team.kind != "Team" or not team.is_active:
        raise HTTPException(
            422, "Agent resource authorization is revoked or unavailable"
        )
    _require_grant(
        db,
        resource_type="Team",
        resource_id=team_id,
        entity_type="chat_group",
        entity_id=str(group_id),
    )
    return team


def require_group_crew(db: Session, group_id: str, crew_id: str) -> Kind:
    crew = (
        resource_query(
            db.query(Kind).filter(Kind.id == int(crew_id)), current=True
        ).first()
        if crew_id.isdecimal()
        else None
    )
    if crew is None or crew.kind != "CollaborationGroup" or not crew.is_active:
        raise HTTPException(422, "Collaboration group is unavailable")
    _require_grant(
        db,
        resource_type="CollaborationGroup",
        resource_id=crew.id,
        entity_type="chat_group",
        entity_id=str(group_id),
    )
    return crew


def authorize_group_team(
    db: Session, group: CollaborationChatGroup, user_id: int, team_id: int
) -> None:
    from app.services.share import team_share_service

    require_collaboration_container_access(
        db, group.id, user_id, BaseRole.Maintainer, write=True
    )
    values = dict(
        resource_type="Team",
        resource_id=team_id,
        entity_type="chat_group",
        entity_id=str(group.id),
        added_by_user_id=user_id,
        role=BaseRole.Developer,
    )
    with resource_member_grant_candidate(db, **values) as existing:
        if existing.status == "approved" and existing.role in RESOURCE_USE_ROLES:
            require_group_team(db, str(group.id), team_id)
            return
        with current_resource_authority():
            team = team_share_service.get_resource(db, team_id, user_id)
            if team is None or team.kind != "Team" or not team.is_active:
                raise HTTPException(422, "Agent is not available to this user")
            if team.user_id != 0:
                team_share_service._ensure_can_manage_members(db, team_id, user_id)
        ensure_resource_member_grant(db, **values)
