# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Safe project roster projections and mutations inside the admin transaction."""

from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, ProjectChatAgent, loop_datetime_is_unset
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.cloud_project import CloudProjectUpdate
from app.schemas.project_admin import ProjectAssistantRosterChange, ProjectMemberChange
from app.services.cloud_project_visibility import project_participant_ids
from app.services.cloud_projects.admin_errors import config_error
from app.services.cloud_projects.members import CloudProjectMemberService
from app.services.collaboration_permissions import (
    collaboration_permission_service,
    project_agent_visible,
)

if TYPE_CHECKING:
    from app.services.cloud_projects.service import CloudProjectService


def roster_configuration(db: Session, project: CloudProject, user_id: int) -> dict:
    """Project only public roster fields after the caller authorizes project access."""
    from app.services.cloud_projects.service import cloud_project_service

    participant_ids = project_participant_ids(db, project)
    capabilities = cloud_project_service._member_capabilities(project)
    users = db.query(User).filter(User.id.in_(participant_ids)).order_by(User.id).all()
    members = []
    for user in users:
        member = CloudProjectMemberService._member_view(
            db, project, user, capabilities, False
        )
        members.append(
            {
                "user_id": member["user_id"],
                "user_name": member["user_name"],
                "permission_role": member["role"],
                "direct_role": member["direct_role"],
                "inherited_role": member["inherited_role"],
                "capability_description": member["capability_description"],
            }
        )
    decision = collaboration_permission_service.check(db, user_id, "read", project.id)
    statuses = (
        ["active", "archived"]
        if has_permission(decision.role, BaseRole.Maintainer)
        else ["active"]
    )
    agents = (
        db.query(ProjectChatAgent)
        .filter(
            ProjectChatAgent.cloud_project_id == project.id,
            ProjectChatAgent.status.in_(statuses),
            loop_datetime_is_unset(ProjectChatAgent.deleted_at),
        )
        .order_by(ProjectChatAgent.id)
        .all()
    )
    return {
        "members": members,
        "assistant_roster": [
            _assistant_configuration(row)
            for row in agents
            if project_agent_visible(row, user_id)
        ],
    }


def _assistant_configuration(row: ProjectChatAgent) -> dict:
    """Allowlist binding identifiers without loading executable source content."""
    from app.services.project_chat.service import bot_runtime_or_none

    metadata = row.metadata_json or {}
    return {
        "agent_id": row.id,
        "agent_version": row.version,
        "name": row.name,
        "status": row.status,
        "capability_description": row.description or "",
        "runtime": bot_runtime_or_none(row),
        "wegent_team_id": metadata.get("wegent_team_id"),
        "execution_device_id": row.device_id or None,
        "default_runtime_profile_id": metadata.get("default_runtime_profile_id"),
    }


def apply_roster_updates(
    service: "CloudProjectService",
    db: Session,
    project: CloudProject,
    user_id: int,
    values: CloudProjectUpdate,
) -> None:
    """Use established member and Agent services without committing the outer unit."""
    # Nested member services refresh the locked project; retain its prepared plan.
    db.flush()
    for change in values.assistant_roster_changes or []:
        _apply_assistant_update(db, project, user_id, change)
    # Complete the authorized batch before its actor loses project administration.
    member_changes = sorted(
        values.member_changes or [], key=lambda change: change.user_id == user_id
    )
    for change in member_changes:
        _apply_member_update(service, db, project, user_id, change)


def _apply_member_update(
    service: "CloudProjectService",
    db: Session,
    project: CloudProject,
    user_id: int,
    change: ProjectMemberChange,
) -> None:
    from app.schemas.cloud_project import (
        CloudProjectMemberCreate,
        CloudProjectMemberUpdate,
    )

    if change.operation == "add":
        service.add_member(
            db,
            int(project.id),
            user_id,
            CloudProjectMemberCreate(
                user_id=change.user_id,
                role=change.permission_role,
                capability_description=change.capability_description or "",
            ),
            commit=False,
        )
    elif change.operation == "remove_direct":
        service.remove_member(
            db, int(project.id), change.user_id, user_id, commit=False
        )
    else:
        service.update_member(
            db,
            int(project.id),
            change.user_id,
            user_id,
            CloudProjectMemberUpdate(
                role=change.permission_role,
                capability_description=change.capability_description,
            ),
            commit=False,
        )


def _apply_assistant_update(
    db: Session,
    project: CloudProject,
    user_id: int,
    change: ProjectAssistantRosterChange,
) -> None:
    from app.schemas.project_chat import ProjectChatAgentUpdate
    from app.services.collaboration_permissions import require_project_agent_visibility
    from app.services.project_chat.service import bot_runtime, project_chat_service

    row = project_chat_service._agent_row(
        db, project_id=str(project.id), agent_id=change.agent_id
    )
    require_project_agent_visibility(row, user_id)
    fields = change.model_fields_set
    runtime = bot_runtime(row)
    if ("wegent_team_id" in fields and runtime != "wegent") or (
        runtime == "wegent"
        and fields & {"execution_device_id", "default_runtime_profile_id"}
    ):
        raise config_error(
            "invalid_config",
            "The selected binding does not apply to this assistant runtime",
            field="assistant_roster_changes",
        )
    request = change.model_dump(
        exclude={"agent_id", "agent_version"}, exclude_unset=True
    )
    project_chat_service.update_agent(
        db,
        user_id=user_id,
        project_id=str(project.id),
        agent_id=change.agent_id,
        request=ProjectChatAgentUpdate(version=change.agent_version, **request),
        commit=False,
    )
