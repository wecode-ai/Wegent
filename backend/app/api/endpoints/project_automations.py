# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wework project automation endpoints."""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user, get_current_user_jwt_apikey_tasktoken
from app.models.user import User
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationDeleteView,
    ProjectAutomationRunView,
    ProjectAutomationUpdate,
    ProjectAutomationView,
    ProjectAutomationWorkflowMigration,
    ProjectAutomationWorkflowMigrationView,
)
from app.schemas.workspace import (
    CollaborationGroupCreate,
    CollaborationGroupListResponse,
    CollaborationGroupResponse,
    CollaborationGroupUpdate,
)
from app.services.project_automations import (
    project_automation_service,
)
from app.services.template_imports import TemplateImportDependency
from app.services.workspaces.service import workspace_service
from shared.telemetry.decorators import trace_sync

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get(
    "/{project_id}/collaboration-groups",
    response_model=CollaborationGroupListResponse,
)
def list_project_collaboration_groups(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> CollaborationGroupListResponse:
    return CollaborationGroupListResponse(
        items=[
            CollaborationGroupResponse.model_validate(group)
            for group in workspace_service.list_project_collaboration_groups(
                db, project_id, current_user.id
            )
        ]
    )


@router.post(
    "/{project_id}/collaboration-groups",
    response_model=CollaborationGroupResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_sync(
    span_name="project.collaboration_group.create", tracer_name="backend.workspaces"
)
def create_project_collaboration_group(
    project_id: int,
    values: CollaborationGroupCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    template_import: TemplateImportDependency = None,
) -> CollaborationGroupResponse:
    stage = "create"
    group_id: object | None = None
    try:
        group = workspace_service.create_project_collaboration_group(
            db, project_id, current_user.id, values, template_import=template_import
        )
        group_id = group["id"]
        stage = "response"
        response = CollaborationGroupResponse.model_validate(group)
    except Exception as error:
        status_code = error.status_code if isinstance(error, HTTPException) else 500
        logger.log(
            logging.WARNING if status_code < 500 else logging.ERROR,
            "Project collaboration group creation failed: project_id=%s "
            "group_id=%s stage=%s status=%s error_type=%s",
            project_id,
            group_id,
            stage,
            status_code,
            type(error).__name__,
        )
        raise
    logger.info(
        "Project collaboration group created: project_id=%s group_id=%s status=201",
        project_id,
        group_id,
    )
    return response


@router.post(
    "/{project_id}/collaboration-groups/{group_id}",
    response_model=CollaborationGroupResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_project_collaboration_group(
    project_id: int,
    group_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CollaborationGroupResponse:
    return CollaborationGroupResponse.model_validate(
        workspace_service.add_project_collaboration_group(
            db, project_id, group_id, current_user.id
        )
    )


@router.patch(
    "/{project_id}/collaboration-groups/{group_id}",
    response_model=CollaborationGroupResponse,
)
def update_project_collaboration_group(
    project_id: int,
    group_id: int,
    values: CollaborationGroupUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CollaborationGroupResponse:
    return CollaborationGroupResponse.model_validate(
        workspace_service.update_project_collaboration_group(
            db,
            project_id,
            group_id,
            current_user.id,
            values,
        )
    )


@router.delete(
    "/{project_id}/collaboration-groups/{group_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_project_collaboration_group(
    project_id: int,
    group_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    workspace_service.remove_project_collaboration_group(
        db, project_id, group_id, current_user.id
    )


@router.get("/{project_id}/automations", response_model=list[ProjectAutomationView])
def list_automations(
    project_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectAutomationView]:
    return project_automation_service.list(db, project_id, current_user.id)


@router.post(
    "/{project_id}/automations/migrate-workflow",
    response_model=ProjectAutomationWorkflowMigrationView,
    status_code=status.HTTP_201_CREATED,
)
def migrate_workflow_automation(
    project_id: str,
    values: ProjectAutomationWorkflowMigration,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAutomationWorkflowMigrationView:
    return project_automation_service.migrate_workflow(
        db,
        project_id,
        current_user.id,
        values,
    )


@router.post(
    "/{project_id}/automations",
    response_model=ProjectAutomationView,
    status_code=status.HTTP_201_CREATED,
)
def create_automation(
    project_id: str,
    values: ProjectAutomationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    template_import: TemplateImportDependency = None,
) -> ProjectAutomationView:
    return project_automation_service.create(
        db, project_id, current_user.id, values, template_import=template_import
    )


@router.patch(
    "/{project_id}/automations/{automation_id}", response_model=ProjectAutomationView
)
def update_automation(
    project_id: str,
    automation_id: str,
    values: ProjectAutomationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAutomationView:
    return project_automation_service.update(
        db, project_id, automation_id, current_user.id, values
    )


@router.delete(
    "/{project_id}/automations/{automation_id}",
    response_model=ProjectAutomationDeleteView,
)
def delete_automation(
    project_id: str,
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAutomationDeleteView:
    return project_automation_service.delete(
        db,
        project_id,
        automation_id,
        current_user.id,
    )


@router.post(
    "/{project_id}/automations/{automation_id}/run",
    response_model=ProjectAutomationRunView,
)
async def run_automation(
    project_id: str,
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAutomationRunView:
    return await project_automation_service.run_now(
        db, project_id, automation_id, current_user.id
    )


@router.get(
    "/{project_id}/automations/{automation_id}/runs",
    response_model=list[ProjectAutomationRunView],
)
def list_runs(
    project_id: str,
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectAutomationRunView]:
    return project_automation_service.list_runs(
        db, project_id, automation_id, current_user.id
    )


@router.post(
    "/{project_id}/automation-runs/{run_id}/cancel",
    response_model=ProjectAutomationRunView,
)
async def cancel_run(
    project_id: str,
    run_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAutomationRunView:
    return await project_automation_service.cancel_run(
        db, project_id, run_id, current_user.id
    )


@router.post(
    "/{project_id}/automation-runs/{run_id}/retry",
    response_model=ProjectAutomationRunView,
)
async def retry_run(
    project_id: str,
    run_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAutomationRunView:
    return await project_automation_service.retry_run(
        db, project_id, run_id, current_user.id
    )
