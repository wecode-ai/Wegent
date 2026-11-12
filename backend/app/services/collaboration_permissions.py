"""Authoritative collaboration decisions and relationship provenance."""

from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import Integer, cast
from sqlalchemy.orm import Query, Session

from app.models.cloud_project import CloudProject
from app.models.delivery import (
    CollaborationChatGroup,
    ProjectChatAgent,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.services.cloud_project_visibility import (
    ROLES_BY_PRIORITY,
    VALID_CLOUD_PROJECT_MEMBER_ROLES,
    collaboration_role,
    project_access_query,
    project_grant_roles,
)

Action = Literal["read", "manage", "edit", "comment", "assign", "execute", "transfer"]
ACTION_ROLES = {
    "read": BaseRole.Viewer,
    "manage": BaseRole.Maintainer,
    "edit": BaseRole.Developer,
    "comment": BaseRole.Developer,
    "assign": BaseRole.Developer,
    "execute": BaseRole.Developer,
    "transfer": BaseRole.Owner,
}
RESOURCE_USE_ROLES = ("Owner", "Maintainer", "Developer")


def resource_query(query: Query, *, current: bool) -> Query:
    """Keep execution authority on locking reads without changing discovery."""
    # Refreshing must preserve the caller's pending changes in this transaction.
    if not current:
        return query
    query.session.flush()
    return query.with_for_update().populate_existing()


def project_agent_visible(agent: ProjectChatAgent, user_id: int) -> bool:
    return (agent.metadata_json or {}).get(
        "visibility"
    ) != "private" or agent.created_by_user_id == user_id


def require_project_agent_visibility(agent: ProjectChatAgent, user_id: int) -> None:
    if not project_agent_visible(agent, user_id):
        raise HTTPException(403, "Private Agent is not shared with this member")


@dataclass(frozen=True)
class PermissionDecision:
    allowed: bool
    role: BaseRole | None
    sources: tuple[dict, ...] = ()
    reason: str | None = None


def _membership(
    db: Session, kind: str, resource_id: int, user_id: int
) -> ResourceMember | None:
    return (
        db.query(ResourceMember)
        .filter_by(
            resource_type=kind,
            resource_id=resource_id,
            entity_type="user",
            entity_id=str(user_id),
            status="approved",
        )
        .filter(ResourceMember.role.in_(VALID_CLOUD_PROJECT_MEMBER_ROLES))
        .first()
    )


class CollaborationPermissionService:
    def workspace_role(
        self, db: Session, workspace_id: int | None, user_id: int
    ) -> BaseRole | None:
        user = db.get(User, user_id)
        if user is None or not user.is_active:
            return None
        workspace = db.get(Kind, workspace_id) if workspace_id else None
        if (
            not workspace
            or workspace.kind != "CollaborationWorkspace"
            or not workspace.is_active
        ):
            return None
        if workspace.user_id == user_id:
            return BaseRole.Owner
        member = _membership(db, "Workspace", workspace_id, user_id)
        return BaseRole(collaboration_role(member.role)) if member else None

    def project_sources(
        self, db: Session, project: CloudProject, user_id: int
    ) -> tuple[dict, ...]:
        role = self.workspace_role(db, project.workspace_id, user_id)
        direct = _membership(db, "CloudProject", int(project.id), user_id)
        return self._project_sources(
            project, role, BaseRole(collaboration_role(direct.role)) if direct else None
        )

    def project_sources_many(
        self,
        project: CloudProject,
        users: list[User],
        *,
        workspace: Kind | None,
        grants: list[ResourceMember],
    ) -> dict[int, tuple[dict, ...]]:
        """Resolve provenance from the same relationships used by the roster."""
        roles = {
            key: BaseRole(role) for key, role in project_grant_roles(grants).items()
        }
        result = {}
        for user in users:
            user_id = user.id
            role = None
            if (
                user.is_active
                and workspace is not None
                and workspace.kind == "CollaborationWorkspace"
                and workspace.is_active
            ):
                role = (
                    BaseRole.Owner
                    if workspace.user_id == user_id
                    else roles.get(("Workspace", str(user_id)))
                )
            result[user_id] = self._project_sources(
                project, role, roles.get(("CloudProject", str(user_id)))
            )
        return result

    @staticmethod
    def _project_sources(
        project: CloudProject, role: BaseRole | None, direct: BaseRole | None
    ) -> tuple[dict, ...]:
        sources = []
        if role and (
            project.membership_mode == "inherit"
            or has_permission(role, BaseRole.Maintainer)
        ):
            sources.append(
                {
                    "type": "workspace",
                    "workspace_id": str(project.workspace_id),
                    "role": (
                        BaseRole.Maintainer.value
                        if role == BaseRole.Owner
                        else role.value
                    ),
                }
            )
        if direct:
            sources.append({"type": "direct", "role": direct.value})
        return tuple(sources)

    def check(
        self,
        db: Session,
        user_id: int,
        action: Action,
        resource_id: int | str,
        *,
        scope: Literal["workspace", "project", "group"] = "project",
    ) -> PermissionDecision:
        required = ACTION_ROLES[action]
        if scope == "workspace":
            role = self.workspace_role(db, int(resource_id), user_id)
            sources = (
                ({"type": "ownership" if role == BaseRole.Owner else "direct"},)
                if role
                else ()
            )
        elif scope == "group":
            group = db.get(CollaborationChatGroup, str(resource_id))
            if group is None:
                return PermissionDecision(False, None, reason="not_accessible")
            from app.services.collaboration_container_access import (
                require_collaboration_container_access,
            )

            try:
                access = require_collaboration_container_access(
                    db, group.id, user_id, required, write=action != "read"
                )
            except HTTPException as error:
                if error.status_code >= 500:
                    raise
                return PermissionDecision(False, None, reason="not_accessible")
            return PermissionDecision(True, access.role, access.sources)
        else:
            if not str(resource_id).isdecimal():
                return PermissionDecision(False, None, reason="not_accessible")
            result = project_access_query(db, user_id, resource_id).first()
            if result is None:
                return PermissionDecision(False, None, reason="not_accessible")
            project, priority = result
            role = ROLES_BY_PRIORITY[priority]
            sources = self.project_sources(db, project, user_id)
            if not sources:
                sources = ({"type": "public", "role": BaseRole.Viewer.value},)
        allowed = role is not None and has_permission(role, required)
        return PermissionDecision(
            allowed, role, sources, None if allowed else "insufficient_permission"
        )

    def check_container(
        self, db: Session, user_id: int, action: Action, resource_id: int | str
    ) -> PermissionDecision:
        """Explicit work/resource entry; project-only management stays project-only."""
        group = db.get(CollaborationChatGroup, str(resource_id))
        return self.check(
            db, user_id, action, resource_id, scope="group" if group else "project"
        )

    def filter(self, db: Session, user_id: int):
        return project_access_query(db, user_id)

    def explain(
        self, db: Session, user_id: int, action: Action, resource_id: int | str
    ):
        return self.check(db, user_id, action, resource_id)

    def require_project_agent(
        self,
        db: Session,
        project_id: int | str,
        agent_id: str,
        *,
        user_id: int | None = None,
        current: bool = False,
    ) -> ProjectChatAgent:
        agent = resource_query(
            db.query(ProjectChatAgent).filter(ProjectChatAgent.id == agent_id),
            current=current,
        ).first()
        if (
            agent is None
            or str(agent.cloud_project_id) != str(project_id)
            or agent.status != "active"
            or not loop_datetime_value_is_unset(agent.deleted_at)
        ):
            raise HTTPException(422, "Agent is not enabled in this project")
        if user_id is not None:
            require_project_agent_visibility(agent, user_id)
        group = db.get(CollaborationChatGroup, str(project_id))
        if group is not None:
            from app.services.group_resource_permissions import (
                require_group_agent,
                require_group_team,
            )

            if group.status != "active" or not loop_datetime_value_is_unset(
                group.deleted_at
            ):
                raise HTTPException(404, "Chat group not found")
            team_id = (agent.metadata_json or {}).get("wegent_team_id")
            if team_id:
                require_group_team(db, str(group.id), int(team_id))
            else:
                require_group_agent(db, group, agent)
            return agent
        team_id = (agent.metadata_json or {}).get("wegent_team_id")
        if team_id:
            self.require_project_team(db, project_id, int(team_id), current=current)
        else:
            project = db.get(CloudProject, str(project_id))
            parent = (
                resource_query(
                    db.query(Kind).filter(Kind.id == project.workspace_id),
                    current=current,
                ).first()
                if project
                else None
            )
            if (
                project is None
                or project.status != "active"
                or parent is None
                or parent.kind != "CollaborationWorkspace"
                or not parent.is_active
            ):
                raise HTTPException(404, "Project not found")
            grant = resource_query(
                db.query(ResourceMember).filter_by(
                    resource_type="Workspace",
                    resource_id=project.workspace_id,
                    entity_type="project_agent",
                    entity_id=agent.id,
                ),
                current=current,
            ).first()
            if grant is None and not (agent.metadata_json or {}).get(
                "authorization_version"
            ):
                # Legacy inline definitions were explicitly installed in this
                # project. Their existing space/project grant is the source;
                # new definitions use independently revocable resource grants.
                return agent
            if (
                grant is None
                or grant.status != "approved"
                or grant.role not in RESOURCE_USE_ROLES
            ):
                raise HTTPException(
                    422, "Agent resource authorization is revoked or unavailable"
                )
        return agent

    def share_project_agent(
        self, db: Session, project: CloudProject, agent: ProjectChatAgent, user_id: int
    ) -> None:
        if isinstance(project, CollaborationChatGroup):
            from app.services.group_resource_permissions import share_group_agent

            share_group_agent(db, project, agent, user_id)
            return
        grant = (
            db.query(ResourceMember)
            .filter_by(
                resource_type="Workspace",
                resource_id=project.workspace_id,
                entity_type="project_agent",
                entity_id=agent.id,
            )
            .first()
        )
        if (
            grant is not None
            and grant.status == "approved"
            and grant.role in RESOURCE_USE_ROLES
        ):
            return
        # Inline definitions belong only to this project. Authorizing one does
        # not expose the parent catalog or publish a reusable Team definition.
        if not self.check(db, user_id, "manage", project.id).allowed:
            raise HTTPException(
                403, "Project administration is required to authorize this Agent"
            )
        if agent.created_by_user_id != user_id:
            raise HTTPException(403, "Only the definition owner can share this Agent")
        if grant is None:
            db.add(
                ResourceMember.create(
                    resource_type="Workspace",
                    resource_id=project.workspace_id,
                    entity_type="project_agent",
                    entity_id=agent.id,
                    role="Developer",
                    status="approved",
                    invited_by_user_id=user_id,
                )
            )
        else:
            grant.status = "approved"
            grant.role = "Developer"
        db.flush()

    def require_project_team(
        self,
        db: Session,
        project_id: int | str,
        team_id: int,
        *,
        require_binding: bool = True,
        current: bool = False,
    ) -> Kind:
        group = db.get(CollaborationChatGroup, str(project_id))
        if group is not None:
            from app.services.group_resource_permissions import require_group_team

            if group.status != "active" or not loop_datetime_value_is_unset(
                group.deleted_at
            ):
                raise HTTPException(404, "Chat group not found")
            team = require_group_team(db, str(group.id), team_id)
            if require_binding:
                binding = (
                    db.query(ProjectChatAgent.id)
                    .filter(
                        ProjectChatAgent.cloud_project_id == str(group.id),
                        ProjectChatAgent.status == "active",
                        loop_datetime_is_unset(ProjectChatAgent.deleted_at),
                        cast(
                            ProjectChatAgent.metadata_json[
                                "wegent_team_id"
                            ].as_string(),
                            Integer,
                        )
                        == team_id,
                    )
                    .first()
                )
                if binding is None:
                    raise HTTPException(422, "Agent is not enabled in this group")
            return team
        project = db.get(CloudProject, str(project_id))
        if project is None or project.status != "active" or not project.workspace_id:
            raise HTTPException(404, "Project not found")
        parent = resource_query(
            db.query(Kind).filter(Kind.id == project.workspace_id), current=current
        ).first()
        if (
            parent is None
            or parent.kind != "CollaborationWorkspace"
            or not parent.is_active
        ):
            raise HTTPException(404, "Project not found")
        grant = resource_query(
            db.query(ResourceMember).filter_by(
                resource_type="Team",
                resource_id=team_id,
                entity_type="workspace",
                entity_id=str(project.workspace_id),
            ),
            current=current,
        ).first()
        team = resource_query(
            db.query(Kind).filter(Kind.id == team_id), current=current
        ).first()
        if team is None or team.kind != "Team" or not team.is_active:
            raise HTTPException(
                422, "Agent resource authorization is revoked or unavailable"
            )
        if grant is None:
            legacy_bindings = resource_query(
                db.query(ProjectChatAgent).filter(
                    ProjectChatAgent.cloud_project_id == str(project_id),
                    ProjectChatAgent.status == "active",
                    loop_datetime_is_unset(ProjectChatAgent.deleted_at),
                    cast(
                        ProjectChatAgent.metadata_json["wegent_team_id"].as_string(),
                        Integer,
                    )
                    == team_id,
                ),
                current=current,
            ).all()
            if not any(
                not (binding.metadata_json or {}).get("authorization_version")
                and (team.user_id == 0 or binding.created_by_user_id == team.user_id)
                for binding in legacy_bindings
            ):
                raise HTTPException(
                    422, "Agent resource authorization is revoked or unavailable"
                )
        elif grant.status != "approved" or grant.role not in RESOURCE_USE_ROLES:
            raise HTTPException(
                422, "Agent resource authorization is revoked or unavailable"
            )
        if require_binding:
            binding = resource_query(
                db.query(ProjectChatAgent.id).filter(
                    ProjectChatAgent.cloud_project_id == str(project_id),
                    ProjectChatAgent.status == "active",
                    loop_datetime_is_unset(ProjectChatAgent.deleted_at),
                    cast(
                        ProjectChatAgent.metadata_json["wegent_team_id"].as_string(),
                        Integer,
                    )
                    == team_id,
                ),
                current=current,
            ).first()
            if binding is None:
                raise HTTPException(422, "Agent is not enabled in this project")
        return team

    def require_project_group(
        self,
        db: Session,
        project_id: int | str,
        group_id: str,
        *,
        current: bool = False,
    ) -> Kind:
        container = db.get(CollaborationChatGroup, str(project_id))
        if container is not None:
            from app.services.group_resource_permissions import require_group_crew

            if container.status != "active" or not loop_datetime_value_is_unset(
                container.deleted_at
            ):
                raise HTTPException(404, "Chat group not found")
            return require_group_crew(db, str(container.id), group_id)
        project = db.get(CloudProject, str(project_id))
        group = (
            resource_query(
                db.query(Kind).filter(Kind.id == int(group_id)), current=current
            ).first()
            if group_id.isdecimal()
            else None
        )
        if (
            project is None
            or group is None
            or group.kind != "CollaborationGroup"
            or not group.is_active
        ):
            raise HTTPException(422, "Collaboration group is unavailable")
        project_grant = resource_query(
            db.query(ResourceMember.id)
            .filter_by(
                resource_type="CollaborationGroup",
                resource_id=group.id,
                entity_type="project",
                entity_id=str(project.id),
                status="approved",
            )
            .filter(ResourceMember.role.in_(RESOURCE_USE_ROLES)),
            current=current,
        ).first()
        if project_grant is None:
            raise HTTPException(
                422, "Collaboration group is not enabled in this project"
            )
        if group.namespace != f"projects/{project.id}":
            grant = resource_query(
                db.query(ResourceMember.id)
                .filter_by(
                    resource_type="CollaborationGroup",
                    resource_id=group.id,
                    entity_type="workspace",
                    entity_id=str(project.workspace_id),
                    status="approved",
                )
                .filter(ResourceMember.role.in_(RESOURCE_USE_ROLES)),
                current=current,
            ).first()
            if grant is None or group.namespace != f"workspaces/{project.workspace_id}":
                raise HTTPException(
                    422, "Collaboration group resource authorization is revoked"
                )
        return group


collaboration_permission_service = CollaborationPermissionService()
