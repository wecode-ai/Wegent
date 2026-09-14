# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Reusable human and Agent collaboration groups owned by Workspaces or Projects."""

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    ProjectAutomationRule,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole
from app.schemas.workspace import (
    CollaborationGroupCreate,
    CollaborationGroupMember,
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
        current = _group_values(
            workspace_id,
            "workspace",
            workspace_id,
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
                owner_type="workspace",
                owner_id=workspace_id,
                name=name,
                exclude_id=group_id,
            )
        leader = (
            values.leader
            if values.leader is not None
            else CollaborationGroupMember.model_validate(current["leader"])
        )
        members = values.members
        if members is None:
            members = [
                CollaborationGroupMember.model_validate(member)
                for member in current["members"]
            ]
        self._validate_members(
            db,
            workspace_id=workspace_id,
            owner_type="workspace",
            owner_id=workspace_id,
            leader=leader,
            members=members,
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
                leader=leader,
                members=members,
                coordination_mode=(
                    values.coordination_mode
                    if values.coordination_mode is not None
                    else str(current["coordination_mode"])
                ),
                policy=(
                    values.policy if values.policy is not None else current["policy"]
                ),
            ),
            version=values.version + 1,
        )
        project_grants = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == COLLABORATION_GROUP_KIND,
                ResourceMember.resource_id == group_id,
                ResourceMember.entity_type == "project",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        for grant in project_grants:
            self._sync_project_automation(
                db,
                project_id=int(grant.entity_id),
                group=group,
                user_id=user_id,
            )
        db.commit()
        db.refresh(group)
        return _group_values(workspace_id, "workspace", workspace_id, group)

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
            if grant.entity_type == "project":
                self._remove_project_automation(
                    db,
                    project_id=int(grant.entity_id),
                    group_id=group_id,
                    user_id=user_id,
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
        self._sync_project_automation(
            db,
            project_id=project_id,
            group=group,
            user_id=user_id,
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
        self._sync_project_automation(
            db,
            project_id=project_id,
            group=group,
            user_id=int(group.user_id),
        )
        db.commit()
        return _group_values(workspace_id, "workspace", workspace_id, group)

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
        self._remove_project_automation(
            db,
            project_id=project_id,
            group_id=group_id,
            user_id=user_id,
        )
        db.commit()

    async def run_project_collaboration_group(
        self,
        db: Session,
        project_id: int,
        group_id: int,
        user_id: int,
    ) -> dict[str, object]:
        from app.services.cloud_projects.access import require_cloud_project_role
        from app.services.project_automations import project_automation_service

        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        if self._project_group_grant(db, project_id, group_id) is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Project collaboration group not found",
            )
        rule = self._project_automation(db, project_id, group_id)
        if rule is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Human-led collaboration groups are started through Issue assignment",
            )
        return await project_automation_service.run_now(
            db,
            str(project_id),
            str(rule.id),
            user_id,
        )

    def list_project_collaboration_group_runs(
        self,
        db: Session,
        project_id: int,
        group_id: int,
        user_id: int,
    ) -> list[dict[str, object]]:
        from app.services.cloud_projects.access import require_cloud_project_role
        from app.services.project_automations import project_automation_service

        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        if self._project_group_grant(db, project_id, group_id) is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Project collaboration group not found",
            )
        rule = self._project_automation(db, project_id, group_id)
        if rule is None:
            return []
        return project_automation_service.list_runs(
            db,
            str(project_id),
            str(rule.id),
            user_id,
        )

    def _sync_project_automation(
        self,
        db: Session,
        *,
        project_id: int,
        group: Kind,
        user_id: int,
    ) -> None:
        """Project one Agent-led group into the existing automation runtime."""

        values = _group_values(
            self._require_project_workspace(db, project_id),
            *_group_owner(group, project_id=project_id),
            group,
        )
        leader = CollaborationGroupMember.model_validate(values["leader"])
        policy = values["policy"]
        if not isinstance(policy, dict):
            policy = {}
        if leader.kind != "agent":
            self._remove_project_automation(
                db,
                project_id=project_id,
                group_id=int(group.id),
                user_id=user_id,
            )
            return

        trigger_type = str(policy.get("trigger_type") or "manual")
        event_type = (
            str(policy.get("event_type"))
            if trigger_type == "event" and policy.get("event_type")
            else None
        )
        event_config = (
            dict(policy.get("event_config") or {}) if trigger_type == "event" else {}
        )
        if event_type in {"task.created", "task.status_changed"}:
            event_config["execution_target"] = "existing_issue"
        if event_type == "task.status_changed":
            event_config["transition"] = "entered_processing"

        rule = self._project_automation(db, project_id, int(group.id))
        from app.services.project_automation_domain import next_run, utcnow

        cron_expression = (
            str(policy.get("cron_expression"))
            if trigger_type == "schedule" and policy.get("cron_expression")
            else None
        )
        timezone = str(policy.get("timezone") or "Asia/Shanghai")
        due_at = (
            next_run(cron_expression, timezone, utcnow())
            if cron_expression and bool(policy.get("enabled", True))
            else None
        )
        output_policy = policy.get("output_policy")
        output_policy = output_policy if isinstance(output_policy, dict) else {}
        prompt = _automation_prompt(
            str(policy.get("prompt") or values["description"] or values["name"]),
            output_policy,
        )
        metadata: dict[str, Any] = {
            "collaboration_group_id": int(group.id),
            "collaboration_group_members": values["members"],
            "coordination_mode": values["coordination_mode"],
            "output_policy": output_policy,
            "trigger_type": trigger_type,
            "event_type": event_type,
            "event_config": event_config,
            "cron_expression": cron_expression,
            "timezone": timezone,
            "last_run_at": None,
            "runtime": {
                "source": "agent_default",
                "runtime_profile_id": None,
                "user_id": None,
            },
        }
        project_agent = (
            db.query(ProjectChatAgent)
            .filter(
                ProjectChatAgent.id == leader.id,
                ProjectChatAgent.cloud_project_id == str(project_id),
                ProjectChatAgent.status == "active",
            )
            .one_or_none()
        )
        if project_agent is None:
            metadata.update(
                {
                    "action": "ai_assign",
                    "role": {"source": "generic", "agent_id": None},
                    "manager": {
                        "type": "wegent",
                        "wegent_team_id": int(leader.id),
                    },
                }
            )
            assignee_agent_id = ""
        else:
            metadata.update(
                {
                    "action": "execute",
                    "role": {"source": "agent", "agent_id": leader.id},
                }
            )
            assignee_agent_id = str(project_agent.id)

        if rule is None:
            rule = ProjectAutomationRule(
                cloud_project_id=str(project_id),
                title=str(values["name"]),
                description=prompt,
                assignee_agent_id=assignee_agent_id,
                status="enabled" if bool(policy.get("enabled", True)) else "disabled",
                due_at=due_at,
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
                metadata_json=metadata,
            )
            db.add(rule)
            db.flush()
            return
        previous = dict(rule.metadata_json or {})
        metadata["last_run_at"] = previous.get("last_run_at")
        rule.title = str(values["name"])
        rule.description = prompt
        rule.assignee_agent_id = assignee_agent_id
        rule.status = "enabled" if bool(policy.get("enabled", True)) else "disabled"
        rule.due_at = due_at
        rule.updated_by_user_id = user_id
        rule.metadata_json = metadata
        rule.version += 1

    @staticmethod
    def _project_automation(
        db: Session,
        project_id: int,
        group_id: int,
    ) -> ProjectAutomationRule | None:
        rows = (
            db.query(ProjectAutomationRule)
            .filter(
                ProjectAutomationRule.cloud_project_id == str(project_id),
                loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
            )
            .all()
        )
        return next(
            (
                row
                for row in rows
                if isinstance(row.metadata_json, dict)
                and row.metadata_json.get("collaboration_group_id") == group_id
            ),
            None,
        )

    def _remove_project_automation(
        self,
        db: Session,
        *,
        project_id: int,
        group_id: int,
        user_id: int,
    ) -> None:
        rule = self._project_automation(db, project_id, group_id)
        if rule is None:
            return
        from app.services.project_automation_domain import utcnow
        from app.services.project_automations import project_automation_service

        project_automation_service._mark_deleted(
            db,
            rule,
            user_id=user_id,
            deleted_at=utcnow(),
        )

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

    def _validate_members(
        self,
        db: Session,
        *,
        workspace_id: int,
        owner_type: str,
        owner_id: int,
        leader: CollaborationGroupMember,
        members: list[CollaborationGroupMember],
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
            "leader": values.leader.model_dump(mode="json"),
            "members": [member.model_dump(mode="json") for member in values.members],
            "coordinationMode": values.coordination_mode,
            "policy": values.policy.model_dump(mode="json"),
        },
        "status": {"state": "active", "version": version},
    }


def _automation_prompt(prompt: str, output_policy: dict[str, object]) -> str:
    mode = str(output_policy.get("mode") or "comment")
    output_instruction = {
        "comment": "完成后在 Issue 中发布结论评论。",
        "delivery": "完成后生成并关联可验收的交付物。",
        "status": "完成后根据结果更新 Issue 状态。",
    }.get(mode, "完成后在 Issue 中发布结论评论。")
    return f"{prompt.strip()}\n\n输出要求：{output_instruction}".strip()


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
    return {
        "id": group.id,
        "workspace_id": workspace_id,
        "owner_type": owner_type,
        "owner_id": owner_id,
        "name": group.name,
        "description": str(spec.get("description") or ""),
        "leader": spec.get("leader") if isinstance(spec.get("leader"), dict) else {},
        "members": members,
        "coordination_mode": str(spec.get("coordinationMode") or "manager"),
        "policy": spec.get("policy") if isinstance(spec.get("policy"), dict) else {},
        "version": int(status_value.get("version") or 1),
        "created_by_user_id": group.user_id,
        "created_at": group.created_at,
        "updated_at": group.updated_at,
    }
