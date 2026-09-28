# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Reusable human and Agent collaboration groups owned by Workspaces or Projects."""

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, ProjectChatAgent
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole
from app.schemas.workspace import (
    CollaborationGroupCreate,
    CollaborationGroupMember,
    CollaborationGroupStage,
    CollaborationGroupUpdate,
)
from app.services.workspaces.access import require_workspace_role
from app.services.workspaces.storage import (
    ensure_resource_grant,
    workspace_id_for_project,
)

COLLABORATION_GROUP_KIND = ResourceType.COLLABORATION_GROUP.value


class WorkspaceCollaborationGroupService:
    """Manage reusable collaboration groups without a dedicated table."""

    def list_collaboration_groups(
        self, db: Session, workspace_id: int, user_id: int
    ) -> list[dict[str, object]]:
        require_workspace_role(db, workspace_id, user_id)
        rows = (
            db.query(ResourceMember, Kind)
            .join(Kind, Kind.id == ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == COLLABORATION_GROUP_KIND,
                ResourceMember.entity_type == "workspace",
                ResourceMember.entity_id == str(workspace_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
                Kind.kind == COLLABORATION_GROUP_KIND,
                Kind.is_active.is_(True),
            )
            .order_by(Kind.name, Kind.id)
            .all()
        )
        return [
            _group_values(workspace_id, "workspace", workspace_id, group)
            for _, group in rows
        ]

    def create_collaboration_group(
        self,
        db: Session,
        workspace_id: int,
        user_id: int,
        values: CollaborationGroupCreate,
    ) -> dict[str, object]:
        require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        self._validate_name_available(
            db,
            owner_type="workspace",
            owner_id=workspace_id,
            name=values.name,
        )
        self._validate_members(
            db,
            workspace_id=workspace_id,
            owner_type="workspace",
            owner_id=workspace_id,
            leader=values.leader,
            members=values.members,
            stages=values.stages,
        )
        group = Kind(
            user_id=user_id,
            kind=COLLABORATION_GROUP_KIND,
            name=values.name,
            namespace=f"workspaces/{workspace_id}",
            json=_group_payload(values),
            is_active=True,
        )
        db.add(group)
        db.flush()
        ensure_resource_grant(
            db,
            workspace_id=workspace_id,
            resource_type=COLLABORATION_GROUP_KIND,
            resource_id=int(group.id),
            added_by_user_id=user_id,
            role=BaseRole.Developer,
        )
        db.commit()
        db.refresh(group)
        return _group_values(workspace_id, "workspace", workspace_id, group)

    def update_collaboration_group(
        self,
        db: Session,
        workspace_id: int,
        group_id: int,
        user_id: int,
        values: CollaborationGroupUpdate,
    ) -> dict[str, object]:
        require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        group = self._get_group(db, workspace_id, group_id)
        result = self._update_owned_group(
            db,
            workspace_id=workspace_id,
            owner_type="workspace",
            owner_id=workspace_id,
            group=group,
            values=values,
        )
        db.commit()
        db.refresh(group)
        return result

    def remove_collaboration_group(
        self,
        db: Session,
        workspace_id: int,
        group_id: int,
        user_id: int,
    ) -> None:
        require_workspace_role(db, workspace_id, user_id, BaseRole.Developer)
        group = self._get_group(db, workspace_id, group_id)
        group.is_active = False
        grants = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == COLLABORATION_GROUP_KIND,
                ResourceMember.resource_id == group_id,
            )
            .all()
        )
        for grant in grants:
            db.delete(grant)
        db.commit()

    def list_project_collaboration_groups(
        self, db: Session, project_id: int, user_id: int
    ) -> list[dict[str, object]]:
        from app.services.cloud_projects.access import require_cloud_project_role

        require_cloud_project_role(db, project_id, user_id)
        workspace_id = self._require_project_workspace(db, project_id)
        rows = (
            db.query(Kind)
            .join(
                ResourceMember,
                (ResourceMember.resource_id == Kind.id)
                & (ResourceMember.resource_type == COLLABORATION_GROUP_KIND),
            )
            .filter(
                Kind.kind == COLLABORATION_GROUP_KIND,
                Kind.is_active.is_(True),
                ResourceMember.entity_type == "project",
                ResourceMember.entity_id == str(project_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .order_by(Kind.name, Kind.id)
            .all()
        )
        return [
            _group_values(
                workspace_id,
                *_group_owner(group, project_id=project_id),
                group,
            )
            for group in rows
        ]

    def create_project_collaboration_group(
        self,
        db: Session,
        project_id: int,
        user_id: int,
        values: CollaborationGroupCreate,
    ) -> dict[str, object]:
        from app.services.cloud_projects.access import require_cloud_project_role

        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        workspace_id = self._require_project_workspace(db, project_id)
        self._validate_name_available(
            db,
            owner_type="project",
            owner_id=project_id,
            name=values.name,
        )
        self._validate_members(
            db,
            workspace_id=workspace_id,
            owner_type="project",
            owner_id=project_id,
            leader=values.leader,
            members=values.members,
            stages=values.stages,
        )
        group = Kind(
            user_id=user_id,
            kind=COLLABORATION_GROUP_KIND,
            name=values.name,
            namespace=f"projects/{project_id}",
            json=_group_payload(values),
            is_active=True,
        )
        db.add(group)
        db.flush()
        db.add(
            ResourceMember.create(
                resource_type=COLLABORATION_GROUP_KIND,
                resource_id=int(group.id),
                entity_type="project",
                entity_id=str(project_id),
                role=BaseRole.Developer.value,
                status=MemberStatus.APPROVED.value,
                invited_by_user_id=user_id,
            )
        )
        db.commit()
        db.refresh(group)
        return _group_values(workspace_id, "project", project_id, group)

    def add_project_collaboration_group(
        self,
        db: Session,
        project_id: int,
        group_id: int,
        user_id: int,
    ) -> dict[str, object]:
        from app.services.cloud_projects.access import require_cloud_project_role

        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        workspace_id = self._require_project_workspace(db, project_id)
        group = self._get_group(db, workspace_id, group_id)
        existing = self._project_group_grant(db, project_id, group_id)
        if existing is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Collaboration group is already added to this Project",
            )
        db.add(
            ResourceMember.create(
                resource_type=COLLABORATION_GROUP_KIND,
                resource_id=group_id,
                entity_type="project",
                entity_id=str(project_id),
                role=BaseRole.Developer.value,
                status=MemberStatus.APPROVED.value,
                invited_by_user_id=user_id,
            )
        )
        db.commit()
        return _group_values(workspace_id, "workspace", workspace_id, group)

    def update_project_collaboration_group(
        self,
        db: Session,
        project_id: int,
        group_id: int,
        user_id: int,
        values: CollaborationGroupUpdate,
    ) -> dict[str, object]:
        from app.services.cloud_projects.access import require_cloud_project_role

        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        workspace_id = self._require_project_workspace(db, project_id)
        group = self._get_project_owned_group(db, project_id, group_id)
        result = self._update_owned_group(
            db,
            workspace_id=workspace_id,
            owner_type="project",
            owner_id=project_id,
            group=group,
            values=values,
        )
        db.commit()
        db.refresh(group)
        return result

    def remove_project_collaboration_group(
        self,
        db: Session,
        project_id: int,
        group_id: int,
        user_id: int,
    ) -> None:
        from app.services.cloud_projects.access import require_cloud_project_role

        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        grant = self._project_group_grant(db, project_id, group_id)
        if grant is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Project collaboration group not found",
            )
        group = db.get(Kind, group_id)
        if group is not None and group.namespace == f"projects/{project_id}":
            group.is_active = False
            grants = (
                db.query(ResourceMember)
                .filter(
                    ResourceMember.resource_type == COLLABORATION_GROUP_KIND,
                    ResourceMember.resource_id == group_id,
                )
                .all()
            )
            for resource_grant in grants:
                db.delete(resource_grant)
        else:
            db.delete(grant)
        db.commit()

    @staticmethod
    def _require_project_workspace(db: Session, project_id: int) -> int:
        workspace_id = workspace_id_for_project(db, project_id)
        if workspace_id is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Project is not attached to a Workspace",
            )
        return workspace_id

    @staticmethod
    def _project_group_grant(
        db: Session, project_id: int, group_id: int
    ) -> ResourceMember | None:
        return (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == COLLABORATION_GROUP_KIND,
                ResourceMember.resource_id == group_id,
                ResourceMember.entity_type == "project",
                ResourceMember.entity_id == str(project_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )

    def _get_project_owned_group(
        self, db: Session, project_id: int, group_id: int
    ) -> Kind:
        row = (
            db.query(Kind)
            .join(
                ResourceMember,
                (ResourceMember.resource_id == Kind.id)
                & (ResourceMember.resource_type == COLLABORATION_GROUP_KIND),
            )
            .filter(
                Kind.id == group_id,
                Kind.kind == COLLABORATION_GROUP_KIND,
                Kind.namespace == f"projects/{project_id}",
                Kind.is_active.is_(True),
                ResourceMember.entity_type == "project",
                ResourceMember.entity_id == str(project_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )
        if row is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Project-owned collaboration group not found",
            )
        return row

    def _get_group(self, db: Session, workspace_id: int, group_id: int) -> Kind:
        row = (
            db.query(Kind)
            .join(
                ResourceMember,
                (ResourceMember.resource_id == Kind.id)
                & (ResourceMember.resource_type == COLLABORATION_GROUP_KIND),
            )
            .filter(
                Kind.id == group_id,
                Kind.kind == COLLABORATION_GROUP_KIND,
                Kind.is_active.is_(True),
                ResourceMember.entity_type == "workspace",
                ResourceMember.entity_id == str(workspace_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )
        if row is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Collaboration group not found"
            )
        return row

    def _validate_name_available(
        self,
        db: Session,
        *,
        owner_type: str,
        owner_id: int,
        name: str,
        exclude_id: int | None = None,
    ) -> None:
        query = (
            db.query(Kind.id)
            .join(
                ResourceMember,
                (ResourceMember.resource_id == Kind.id)
                & (ResourceMember.resource_type == COLLABORATION_GROUP_KIND),
            )
            .filter(
                Kind.kind == COLLABORATION_GROUP_KIND,
                Kind.name == name,
                Kind.is_active.is_(True),
                ResourceMember.entity_type == owner_type,
                ResourceMember.entity_id == str(owner_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
        )
        if exclude_id is not None:
            query = query.filter(Kind.id != exclude_id)
        if query.first() is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Collaboration group name already exists in this owner scope",
            )

    def _update_owned_group(
        self,
        db: Session,
        *,
        workspace_id: int,
        owner_type: str,
        owner_id: int,
        group: Kind,
        values: CollaborationGroupUpdate,
    ) -> dict[str, object]:
        current = _group_values(
            workspace_id,
            owner_type,
            owner_id,
            group,
        )
        if current["version"] != values.version:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Collaboration group was updated by another request",
            )
        name = values.name if values.name is not None else str(current["name"])
        if name != group.name:
            self._validate_name_available(
                db,
                owner_type=owner_type,
                owner_id=owner_id,
                name=name,
                exclude_id=int(group.id),
            )
        leader = (
            values.leader
            if values.leader is not None
            else CollaborationGroupMember.model_validate(current["leader"])
        )
        members = values.members or [
            CollaborationGroupMember.model_validate(member)
            for member in current["members"]
        ]
        stages = (
            values.stages
            if values.stages is not None
            else [
                CollaborationGroupStage.model_validate(stage)
                for stage in current["stages"]
            ]
        )
        self._validate_members(
            db,
            workspace_id=workspace_id,
            owner_type=owner_type,
            owner_id=owner_id,
            leader=leader,
            members=members,
            stages=stages,
        )
        group.name = name
        group.json = _group_payload(
            CollaborationGroupCreate(
                name=name,
                description=(
                    values.description
                    if values.description is not None
                    else str(current["description"])
                ),
                instructions=(
                    values.instructions
                    if values.instructions is not None
                    else str(current["instructions"])
                ),
                leader=leader,
                members=members,
                coordination_mode=(
                    values.coordination_mode
                    if values.coordination_mode is not None
                    else str(current["coordination_mode"])
                ),
                stages=stages,
                execution_requirements=(
                    values.execution_requirements
                    if values.execution_requirements is not None
                    else current["execution_requirements"]
                ),
            ),
            version=values.version + 1,
        )
        db.flush()
        db.refresh(group)
        return _group_values(
            workspace_id,
            owner_type,
            owner_id,
            group,
        )

    def _validate_members(
        self,
        db: Session,
        *,
        workspace_id: int,
        owner_type: str,
        owner_id: int,
        leader: CollaborationGroupMember,
        members: list[CollaborationGroupMember],
        stages: list[CollaborationGroupStage],
    ) -> None:
        identities = {(member.kind, member.id) for member in members}
        if len(identities) != len(members):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Collaboration group members must be unique",
            )
        if (leader.kind, leader.id) not in identities:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Leader must be a member of the collaboration group",
            )
        if any(
            stage.assignee is not None
            and (stage.assignee.kind, stage.assignee.id) not in identities
            for stage in stages
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Collaboration group stage assignee must be a group member",
            )
        if any(
            stage.assignee is not None
            and (stage.assignee.kind, stage.assignee.id) == (leader.kind, leader.id)
            for stage in stages
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Collaboration group leader cannot execute a stage",
            )
        for member_kind, member_id in identities:
            available = (
                self._agent_is_available(
                    db,
                    workspace_id=workspace_id,
                    owner_type=owner_type,
                    owner_id=owner_id,
                    agent_id=member_id,
                )
                if member_kind == "agent"
                else self._human_is_available(
                    db,
                    workspace_id=workspace_id,
                    owner_type=owner_type,
                    owner_id=owner_id,
                    user_id=int(member_id),
                )
            )
            if not available:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    f"{member_kind.capitalize()} is not available in this "
                    f"{owner_type.capitalize()}",
                )

    @staticmethod
    def _human_is_available(
        db: Session,
        *,
        workspace_id: int,
        owner_type: str,
        owner_id: int,
        user_id: int,
    ) -> bool:
        resource_type = (
            ResourceType.WORKSPACE.value
            if owner_type == "workspace"
            else ResourceType.CLOUD_PROJECT.value
        )
        resource_id = workspace_id if owner_type == "workspace" else owner_id
        if owner_type == "project":
            project = db.get(CloudProject, owner_id)
            if project is not None and int(project.created_by_user_id) == user_id:
                return True
        return (
            db.query(ResourceMember.id)
            .filter(
                ResourceMember.resource_type == resource_type,
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
            is not None
        )

    @staticmethod
    def _agent_is_available(
        db: Session,
        *,
        workspace_id: int,
        owner_type: str,
        owner_id: int,
        agent_id: str,
    ) -> bool:
        if agent_id.isdigit():
            workspace_grant = (
                db.query(ResourceMember.id)
                .filter(
                    ResourceMember.resource_type == ResourceType.TEAM.value,
                    ResourceMember.resource_id == int(agent_id),
                    ResourceMember.entity_type == "workspace",
                    ResourceMember.entity_id == str(workspace_id),
                    ResourceMember.status == MemberStatus.APPROVED.value,
                )
                .first()
            )
            if workspace_grant is not None:
                return True
        if owner_type != "project":
            return False
        project_agents = (
            db.query(ProjectChatAgent)
            .filter(
                ProjectChatAgent.cloud_project_id == str(owner_id),
                ProjectChatAgent.status == "active",
            )
            .all()
        )
        return any(
            str(agent.id) == agent_id
            or (
                agent_id.isdigit()
                and isinstance(agent.metadata_json, dict)
                and agent.metadata_json.get("wegent_team_id") == int(agent_id)
            )
            for agent in project_agents
        )


def _group_payload(
    values: CollaborationGroupCreate, *, version: int = 1
) -> dict[str, Any]:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": COLLABORATION_GROUP_KIND,
        "metadata": {"name": values.name},
        "spec": {
            "description": values.description,
            "instructions": values.instructions,
            "leader": values.leader.model_dump(mode="json"),
            "members": [member.model_dump(mode="json") for member in values.members],
            "coordinationMode": values.coordination_mode,
            "stages": [stage.model_dump(mode="json") for stage in values.stages],
            "executionRequirements": values.execution_requirements.model_dump(
                mode="json"
            ),
        },
        "status": {"state": "active", "version": version},
    }


def _group_owner(group: Kind, *, project_id: int) -> tuple[str, int]:
    if group.namespace == f"projects/{project_id}":
        return "project", project_id
    if group.namespace.startswith("workspaces/"):
        return "workspace", int(group.namespace.removeprefix("workspaces/"))
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        "Collaboration group has an invalid owner namespace",
    )


def _group_values(
    workspace_id: int,
    owner_type: str,
    owner_id: int,
    group: Kind,
) -> dict[str, object]:
    payload = group.json if isinstance(group.json, dict) else {}
    spec = payload.get("spec")
    spec = spec if isinstance(spec, dict) else {}
    status_value = payload.get("status")
    status_value = status_value if isinstance(status_value, dict) else {}
    raw_members = spec.get("members")
    members = raw_members if isinstance(raw_members, list) else []
    raw_stages = spec.get("stages")
    stages = raw_stages if isinstance(raw_stages, list) else []
    raw_execution_requirements = spec.get("executionRequirements")
    execution_requirements = (
        raw_execution_requirements
        if isinstance(raw_execution_requirements, dict)
        else {"required_tags": []}
    )
    return {
        "id": group.id,
        "workspace_id": workspace_id,
        "owner_type": owner_type,
        "owner_id": owner_id,
        "name": group.name,
        "description": str(spec.get("description") or ""),
        "instructions": str(spec.get("instructions") or ""),
        "leader": spec.get("leader") if isinstance(spec.get("leader"), dict) else {},
        "members": members,
        "coordination_mode": str(spec.get("coordinationMode") or "manager"),
        "stages": stages,
        "execution_requirements": execution_requirements,
        "version": int(status_value.get("version") or 1),
        "created_by_user_id": group.user_id,
        "created_at": group.created_at,
        "updated_at": group.updated_at,
    }
