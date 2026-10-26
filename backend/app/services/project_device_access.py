"""Project device policies extend, and never replace, resource use grants."""

import hashlib
import json

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.base_role import BaseRole
from app.schemas.project_device_access import (
    ProjectDeviceAccess,
    ProjectDeviceAccessChange,
    ProjectDeviceAccessPreview,
)
from app.services.cloud_project_visibility import project_participant_ids
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.device.identity import resolve_owned_device_alias
from shared.telemetry.decorators import trace_sync

POLICY_KEY = "execution_device_access"


def device_access(project: CloudProject, device_id: int) -> ProjectDeviceAccess:
    policies = (project.metadata_json or {}).get(POLICY_KEY, {})
    if isinstance(policies, dict) and str(device_id) not in policies:
        # CP11 preserves the consent of installations predating scoped policies.
        return ProjectDeviceAccess(scope="project")
    try:
        return ProjectDeviceAccess.model_validate(policies[str(device_id)])
    except (ValidationError, TypeError, KeyError):
        return ProjectDeviceAccess()


def can_manage_device_access(db: Session, device: Kind, user_id: int) -> bool:
    workspace_id = ((device.json or {}).get("spec") or {}).get("workspaceOwnerId")
    if not workspace_id:
        return device.user_id == user_id
    from app.services.collaboration_permissions import collaboration_permission_service

    role = collaboration_permission_service.workspace_role(
        db, int(workspace_id), user_id
    )
    return role in {BaseRole.Owner, BaseRole.Maintainer}


def can_use_device(
    db: Session,
    project: CloudProject,
    device: Kind,
    user_id: int,
    policy: ProjectDeviceAccess | None = None,
) -> bool:
    policy = policy or device_access(project, device.id)
    return can_manage_device_access(db, device, user_id) or (
        policy.scope == "project"
        or policy.scope == "members"
        and user_id in policy.member_ids
    )


def filter_device_access(
    db: Session, project_id: str, user_id: int, device_ids: set[int]
) -> set[int]:
    project = (
        db.query(CloudProject)
        .filter_by(id=str(project_id))
        .populate_existing()
        .one_or_none()
    )
    if project is None:
        return set()
    return {
        device.id
        for device in db.query(Kind).filter(
            Kind.id.in_(device_ids), Kind.kind == "Device", Kind.is_active.is_(True)
        )
        if can_use_device(db, project, device, user_id)
    }


def set_device_access(
    project: CloudProject, device_id: int, policy: ProjectDeviceAccess
) -> None:
    metadata = dict(project.metadata_json or {})
    stored = metadata.get(POLICY_KEY, {})
    if not isinstance(stored, dict):
        raise HTTPException(409, "Device permission metadata is invalid")
    policies = dict(stored)
    policies[str(device_id)] = policy.model_dump(include={"scope", "member_ids"})
    metadata[POLICY_KEY] = policies
    project.metadata_json = metadata


def _affected_executions(
    db: Session, project: CloudProject, device: Kind, policy: ProjectDeviceAccess
) -> list[LoopItemExecution]:
    from app.services.collaboration_revocation import ACTIVE_WORK_STATUSES

    rows = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.cloud_project_id == str(project.id),
            LoopItemExecution.status.in_(ACTIVE_WORK_STATUSES),
            LoopItemExecution.execution_environment != "wegent",
        )
        .with_for_update()
    )
    affected = []
    for row in rows:
        if can_use_device(db, project, device, row.assigner_user_id, policy):
            continue
        alias = row.runtime_device_id or row.execution_device_id
        if not alias and row.uses_runner_routing:
            from app.services.runner_routing import unbound_execution_environment_ids

            ids = unbound_execution_environment_ids(db, row)
            if ids == {device.id}:
                affected.append(row)
            continue
        runner = (
            resolve_owned_device_alias(
                db, user_id=row.executor_owner_user_id, device_id=alias
            )
            if alias
            else None
        )
        if runner is not None and runner.id == device.id:
            affected.append(row)
    return affected


def _preview(
    project: CloudProject,
    device: Kind,
    policy: ProjectDeviceAccess,
    executions: list[LoopItemExecution],
) -> ProjectDeviceAccessPreview:
    plan = [
        str(project.id),
        project.version,
        device.id,
        policy.model_dump(include={"scope", "member_ids"}),
        sorted((str(row.id), row.version, row.status) for row in executions),
    ]
    return ProjectDeviceAccessPreview(
        affected_execution_count=len(executions),
        affected_agent_count=len({row.agent_id for row in executions if row.agent_id}),
        confirmation_token=hashlib.sha256(
            json.dumps(plan, sort_keys=True).encode()
        ).hexdigest(),
    )


@trace_sync("project.update_device_access", tracer_name="backend")
def update_device_access(
    db: Session,
    project_id: int,
    user_id: int,
    version: int,
    change: ProjectDeviceAccessChange,
) -> tuple[CloudProject, ProjectDeviceAccessPreview | None]:
    from app.services.cloud_projects.service import cloud_project_service
    from app.services.runner_routing import project_environment_ids

    require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
    project = cloud_project_service._lock_project(db, project_id)
    if project.version != version:
        raise HTTPException(409, "Project changed; reload device permissions")
    device = (
        db.query(Kind)
        .filter_by(
            id=change.device_id, kind="Device", namespace="default", is_active=True
        )
        .one_or_none()
    )
    if device is None or device.id not in project_environment_ids(db, str(project_id)):
        raise HTTPException(404, "Project execution environment not found")
    if not can_manage_device_access(db, device, user_id):
        raise HTTPException(403, "Only the device owner can change use permissions")
    participants = project_participant_ids(
        db, project, required_role=BaseRole.Developer
    )
    if not set(change.member_ids) <= participants:
        raise HTTPException(422, "Select current project members who can execute")
    affected = _affected_executions(db, project, device, change)
    preview = _preview(project, device, change, affected)
    if change.preview_only:
        db.rollback()
        return project, preview
    if change.confirmation_token != preview.confirmation_token:
        raise HTTPException(409, "Device permission impact changed; preview again")
    return _save(db, project, device, change, affected)


def _save(
    db: Session,
    project: CloudProject,
    device: Kind,
    policy: ProjectDeviceAccess,
    affected: list[LoopItemExecution],
) -> tuple[CloudProject, None]:
    from app.services.collaboration_revocation import revoke_unauthorized_project_work
    from app.services.loop_item_executions.cancellation import (
        request_execution_cancellations,
    )

    set_device_access(project, device.id, policy)
    project.version += 1
    db.flush()
    pending = revoke_unauthorized_project_work(
        db, project.id, execution_ids={str(row.id) for row in affected}
    )
    db.commit()
    request_execution_cancellations(pending)
    db.refresh(project)
    return project, None
