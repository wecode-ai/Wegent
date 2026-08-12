# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project workflow resource configuration and task bindings."""

import secrets
from urllib.parse import urlparse

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.webhook_secrets import encrypt_webhook_secret
from app.models.project_workflow import (
    ProjectAgentSquad,
    ProjectRepositoryBinding,
    ProjectWorkflowDefinition,
    TaskExecutionBinding,
)
from app.schemas.base_role import BaseRole
from app.schemas.project_workflow import (
    ConfigurationValidationView,
    ProjectAgentSquadCreate,
    ProjectAgentSquadUpdate,
    ProjectAgentSquadView,
    RepositoryBindingCreate,
    RepositoryBindingUpdate,
    RepositoryBindingView,
    RepositoryWebhookSecretView,
    SquadRoutePreviewInput,
    SquadRoutePreviewMember,
    SquadRoutePreviewView,
    TaskExecutionBindingUpsert,
    TaskExecutionBindingView,
    WorkflowDefinitionCreate,
    WorkflowDefinitionUpdate,
    WorkflowDefinitionView,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_item_executions.service import utcnow
from app.services.project_workflows.common import (
    _id,
    _iso,
    _optional_text,
    _row_version,
)


class ProjectWorkflowConfigurationMixin:
    """Project workflow resource configuration and task bindings."""

    def list_squads(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
    ) -> list[ProjectAgentSquadView]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        rows = (
            db.query(ProjectAgentSquad)
            .filter(
                ProjectAgentSquad.cloud_project_id == str(project_id),
                ProjectAgentSquad.status == "active",
            )
            .order_by(ProjectAgentSquad.created_at.asc())
            .all()
        )
        return [self._squad_view(row) for row in rows]

    def create_squad(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        request: ProjectAgentSquadCreate,
    ) -> ProjectAgentSquadView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        self._validate_project_agents(
            db,
            project_id=project_id,
            agent_ids=request.member_agent_ids,
        )
        row = ProjectAgentSquad(
            id=_id(),
            cloud_project_id=str(project_id),
            name=request.name,
            leader_agent_id=request.leader_agent_id,
            member_agent_ids=request.member_agent_ids,
            routing_instructions=request.routing_instructions,
            max_parallel_members=request.max_parallel_members,
            created_by_user_id=user_id,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._squad_view(row)

    def update_squad(
        self,
        db: Session,
        *,
        project_id: int,
        squad_id: str,
        user_id: int,
        request: ProjectAgentSquadUpdate,
    ) -> ProjectAgentSquadView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        row = self._get_squad(db, project_id, squad_id, active_only=False)
        _row_version(row, request.version)
        values = request.model_dump(exclude_unset=True, exclude={"version"})
        member_ids = values.get("member_agent_ids", row.member_agent_ids)
        leader_id = values.get("leader_agent_id", row.leader_agent_id)
        if len(set(member_ids)) != len(member_ids):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Duplicate members"
            )
        if leader_id not in member_ids:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Leader must be included in squad members",
            )
        self._validate_project_agents(
            db,
            project_id=project_id,
            agent_ids=member_ids,
        )
        for key, value in values.items():
            setattr(row, key, value)
        row.version += 1
        db.commit()
        db.refresh(row)
        return self._squad_view(row)

    def preview_squad_route(
        self,
        db: Session,
        *,
        project_id: int,
        squad_id: str,
        user_id: int,
        request: SquadRoutePreviewInput,
    ) -> SquadRoutePreviewView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        row = self._get_squad(db, project_id, squad_id)
        members = [row.leader_agent_id]
        members.extend(
            member_id
            for member_id in row.member_agent_ids
            if member_id != row.leader_agent_id
        )
        selected = members[: row.max_parallel_members]
        return SquadRoutePreviewView(
            squad_id=row.id,
            leader_agent_id=row.leader_agent_id,
            selected_members=[
                SquadRoutePreviewMember(
                    agent_id=agent_id,
                    instruction=(
                        f"Evaluate and execute this simulated task within the squad "
                        f"routing constraints: {request.task}"
                    ),
                    required_artifacts=[],
                    execution_mode="parallel",
                )
                for agent_id in selected
            ],
            explanation=(
                "Preview only. The platform selected the leader first, then bounded "
                "eligible squad members by maxParallelMembers; no run was created."
            ),
        )

    def list_repositories(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
    ) -> list[RepositoryBindingView]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        rows = (
            db.query(ProjectRepositoryBinding)
            .filter(
                ProjectRepositoryBinding.cloud_project_id == str(project_id),
                ProjectRepositoryBinding.status == "active",
            )
            .order_by(ProjectRepositoryBinding.created_at.asc())
            .all()
        )
        return [self._repository_view(row) for row in rows]

    def create_repository(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        request: RepositoryBindingCreate,
    ) -> RepositoryBindingView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        target = request.default_execution_target
        if target:
            self.resolve_execution_target(db, user_id=user_id, target=target)
        duplicate = (
            db.query(ProjectRepositoryBinding.id)
            .filter(
                ProjectRepositoryBinding.cloud_project_id == str(project_id),
                ProjectRepositoryBinding.repository_identity
                == request.repository_identity,
            )
            .first()
        )
        if duplicate:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Repository is already bound to this project",
            )
        row = ProjectRepositoryBinding(
            id=_id(),
            cloud_project_id=str(project_id),
            provider=request.provider,
            repository_identity=request.repository_identity,
            repository_url=request.repository_url,
            default_branch=request.default_branch,
            local_project_id=request.local_project_id or 0,
            execution_target_type=(target.type if target else "registered_device"),
            execution_target_id=target.id if target and target.id else "",
            credential_ref=request.credential_ref or "",
            workspace_policy_json=request.workspace_policy,
            git_policy_json=request.git_policy,
            provider_settings_json=request.provider_settings,
            created_by_user_id=user_id,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._repository_view(row)

    def update_repository(
        self,
        db: Session,
        *,
        project_id: int,
        binding_id: str,
        user_id: int,
        request: RepositoryBindingUpdate,
    ) -> RepositoryBindingView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        row = self._get_repository(db, project_id, binding_id, active_only=False)
        _row_version(row, request.version)
        values = request.model_dump(exclude_unset=True, exclude={"version"})
        target = values.pop("default_execution_target", None)
        if target is not None:
            self.resolve_execution_target(db, user_id=user_id, target=target)
            row.execution_target_type = target.type
            row.execution_target_id = target.id or ""
        mappings = {
            "workspace_policy": "workspace_policy_json",
            "git_policy": "git_policy_json",
            "provider_settings": "provider_settings_json",
        }
        for key, value in values.items():
            if key == "local_project_id":
                value = value or 0
            elif key == "credential_ref":
                value = value or ""
            setattr(row, mappings.get(key, key), value)
        row.version += 1
        db.commit()
        db.refresh(row)
        return self._repository_view(row)

    def rotate_repository_webhook_secret(
        self,
        db: Session,
        *,
        project_id: int,
        binding_id: str,
        user_id: int,
    ) -> RepositoryWebhookSecretView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        row = self._get_repository(db, project_id, binding_id)
        secret = secrets.token_urlsafe(32)
        rotated_at = utcnow()
        row.webhook_secret_ciphertext = encrypt_webhook_secret(secret)
        row.webhook_secret_last_rotated_at = rotated_at
        row.version += 1
        db.commit()
        return RepositoryWebhookSecretView(
            binding_id=row.id,
            secret=secret,
            rotated_at=_iso(rotated_at),
        )

    def validate_repository(
        self,
        db: Session,
        *,
        project_id: int,
        binding_id: str,
        user_id: int,
    ) -> ConfigurationValidationView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        row = self._get_repository(db, project_id, binding_id)
        issues: list[str] = []
        parsed = urlparse(row.repository_url)
        if parsed.scheme not in {"http", "https", "ssh", "git"}:
            issues.append("Repository URL must use http, https, ssh, or git")
        if row.provider in {"github", "gitlab"} and not row.credential_ref:
            issues.append("Provider credential reference is not configured")
        if not row.default_branch.strip():
            issues.append("Default branch is required")
        return ConfigurationValidationView(valid=not issues, issues=issues)

    def validate_workflow(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        request: WorkflowDefinitionCreate,
    ) -> ConfigurationValidationView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        self._validate_workflow_definition(
            db,
            project_id=project_id,
            user_id=user_id,
            request=request,
        )
        issues: list[str] = []
        if not any(
            node.type == "agent" for group in request.stages for node in group.nodes
        ):
            issues.append("Workflow must contain at least one AI execution node")
        if (
            any(
                node.type == "merge" for group in request.stages for node in group.nodes
            )
            and not request.repository_binding_id
        ):
            issues.append("Merge nodes require a repository binding")
        return ConfigurationValidationView(valid=not issues, issues=issues)

    def list_workflows(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
    ) -> list[WorkflowDefinitionView]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        rows = (
            db.query(ProjectWorkflowDefinition)
            .filter(
                ProjectWorkflowDefinition.cloud_project_id == str(project_id),
                ProjectWorkflowDefinition.status == "active",
            )
            .order_by(
                ProjectWorkflowDefinition.is_default.desc(),
                ProjectWorkflowDefinition.created_at.asc(),
            )
            .all()
        )
        return [self._workflow_view(row) for row in rows]

    def create_workflow(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        request: WorkflowDefinitionCreate,
    ) -> WorkflowDefinitionView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        self._validate_workflow_definition(
            db,
            project_id=project_id,
            user_id=user_id,
            request=request,
        )
        if request.is_default:
            self._clear_default_workflows(db, project_id)
        row = ProjectWorkflowDefinition(
            id=_id(),
            cloud_project_id=str(project_id),
            name=request.name,
            description=request.description,
            trigger_mode=request.trigger_mode,
            repository_binding_id=request.repository_binding_id or "",
            stages_json=[
                stage.model_dump(mode="json", by_alias=False)
                for stage in request.stages
            ],
            failure_policy=request.failure_policy,
            is_default=int(request.is_default),
            created_by_user_id=user_id,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._workflow_view(row)

    def update_workflow(
        self,
        db: Session,
        *,
        project_id: int,
        workflow_id: str,
        user_id: int,
        request: WorkflowDefinitionUpdate,
    ) -> WorkflowDefinitionView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        row = self._get_workflow(db, project_id, workflow_id, active_only=False)
        _row_version(row, request.version)
        values = request.model_dump(exclude_unset=True, exclude={"version"})
        if "stages" in values:
            definition = WorkflowDefinitionCreate(
                name=values.get("name", row.name),
                description=values.get("description", row.description),
                trigger_mode=values.get("trigger_mode", row.trigger_mode),
                repository_binding_id=values.get(
                    "repository_binding_id",
                    _optional_text(row.repository_binding_id),
                ),
                stages=values["stages"],
                failure_policy=values.get("failure_policy", row.failure_policy),
                is_default=bool(values.get("is_default", row.is_default)),
            )
            self._validate_workflow_definition(
                db,
                project_id=project_id,
                user_id=user_id,
                request=definition,
            )
            values["stages"] = [
                stage.model_dump(mode="json", by_alias=False)
                for stage in definition.stages
            ]
        if values.get("is_default"):
            self._clear_default_workflows(db, project_id)
        for key, value in values.items():
            if key == "stages":
                row.stages_json = value
            elif key == "is_default":
                row.is_default = int(value)
            elif key == "repository_binding_id":
                row.repository_binding_id = value or ""
            else:
                setattr(row, key, value)
        row.version += 1
        db.commit()
        db.refresh(row)
        return self._workflow_view(row)

    def get_task_binding(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
    ) -> TaskExecutionBindingView | None:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        self._require_task(db, project_id, item_id)
        row = (
            db.query(TaskExecutionBinding)
            .filter(TaskExecutionBinding.loop_item_id == item_id)
            .first()
        )
        return self._binding_view(row) if row else None

    def upsert_task_binding(
        self,
        db: Session,
        *,
        project_id: int,
        item_id: str,
        user_id: int,
        request: TaskExecutionBindingUpsert,
    ) -> TaskExecutionBindingView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        self._require_task(db, project_id, item_id)
        if request.repository_binding_id:
            self._get_repository(
                db,
                project_id,
                request.repository_binding_id,
            )
        if request.actor:
            target_type = request.actor.type
            target_id = request.actor.stable_id()
            target_snapshot = self.resolve_actor(
                db,
                project_id=project_id,
                user_id=user_id,
                actor=request.actor,
            )
        else:
            workflow = self._get_workflow(
                db,
                project_id,
                str(request.workflow_id),
            )
            target_type = "workflow"
            target_id = workflow.id
            target_snapshot = self._workflow_snapshot(workflow)
        self.resolve_execution_target(
            db,
            user_id=user_id,
            target=request.execution_target,
        )
        row = (
            db.query(TaskExecutionBinding)
            .filter(TaskExecutionBinding.loop_item_id == item_id)
            .first()
        )
        if row:
            if request.version is None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "version is required when updating an execution binding",
                )
            _row_version(row, request.version)
            row.target_type = target_type
            row.target_id = target_id
            row.target_snapshot = target_snapshot
            row.repository_binding_id = request.repository_binding_id or ""
            row.execution_target_type = request.execution_target.type
            row.execution_target_id = request.execution_target.id or ""
            row.workspace_mode = request.workspace_mode
            row.version += 1
        else:
            row = TaskExecutionBinding(
                loop_item_id=item_id,
                target_type=target_type,
                target_id=target_id,
                target_snapshot=target_snapshot,
                repository_binding_id=request.repository_binding_id or "",
                execution_target_type=request.execution_target.type,
                execution_target_id=request.execution_target.id or "",
                workspace_mode=request.workspace_mode,
                created_by_user_id=user_id,
            )
            db.add(row)
        db.commit()
        db.refresh(row)
        return self._binding_view(row)
