# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wework project automation endpoints."""

import logging

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    status,
)
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user, get_current_user_jwt_apikey_tasktoken
from app.models.delivery import (
    ProjectAutomationRun,
)
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemResponse
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationDeleteView,
    ProjectAutomationManagerAssign,
    ProjectAutomationRunView,
    ProjectAutomationUpdate,
    ProjectAutomationView,
    ProjectAutomationWorkflowMigration,
    ProjectAutomationWorkflowMigrationView,
)
from app.schemas.project_manager import (
    ProjectManagerConfig,
    ProjectManagerConfigView,
    ProjectManagerActionView,
    ProjectManagerDecision,
    ProjectManagerInstruction,
    ProjectManagerRunDetail,
    ProjectManagerRunView,
)
from app.schemas.workspace import (
    CollaborationGroupCreate,
    CollaborationGroupListResponse,
    CollaborationGroupResponse,
    CollaborationGroupUpdate,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.project_automation_execution import project_automation_execution
from app.services.project_automations import (
    project_automation_service,
)
from app.services.project_manager import project_manager_service
from app.services.workspaces import workspace_service

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/{project_id}/project-manager", response_model=ProjectManagerConfigView)
def get_project_manager(
    project_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectManagerConfigView:
    return project_manager_service.get(db, project_id, current_user.id)


@router.put("/{project_id}/project-manager", response_model=ProjectManagerConfigView)
def save_project_manager(
    project_id: str,
    values: ProjectManagerConfig,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectManagerConfigView:
    return project_manager_service.save(db, project_id, current_user.id, values)


@router.post("/{project_id}/project-manager/runs", response_model=ProjectManagerRunView)
async def run_project_manager(
    project_id: str,
    values: ProjectManagerInstruction,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectManagerRunView:
    return await project_manager_service.run_now(
        db, project_id, current_user.id, values.message
    )


@router.get(
    "/{project_id}/project-manager/runs", response_model=list[ProjectManagerRunView]
)
def list_project_manager_runs(
    project_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectManagerRunView]:
    return project_manager_service.list_runs(db, project_id, current_user.id)


@router.get(
    "/{project_id}/project-manager/runs/{run_id}",
    response_model=ProjectManagerRunDetail,
)
def get_project_manager_run(
    project_id: str,
    run_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return project_manager_service.run_detail(db, project_id, run_id, current_user.id)


@router.post(
    "/{project_id}/project-manager/runs/{run_id}/actions/{action_id}/decision",
    response_model=ProjectManagerActionView,
)
def decide_project_manager_action(
    project_id: str,
    run_id: str,
    action_id: str,
    values: ProjectManagerDecision,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return project_manager_service.decide_change(
        db,
        project_id=project_id,
        run_id=run_id,
        action_id=action_id,
        user_id=current_user.id,
        approve=values.approve,
        version=values.version,
    )


@router.get(
    "/{project_id}/collaboration-groups",
    response_model=CollaborationGroupListResponse,
)
def list_project_collaboration_groups(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
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
def create_project_collaboration_group(
    project_id: int,
    values: CollaborationGroupCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CollaborationGroupResponse:
    return CollaborationGroupResponse.model_validate(
        workspace_service.create_project_collaboration_group(
            db, project_id, current_user.id, values
        )
    )


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
) -> ProjectAutomationView:
    return project_automation_service.create(db, project_id, current_user.id, values)


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


@router.post(
    "/{project_id}/loop-items/{item_id}/workflow-nodes/{workflow_node_id}/run",
    response_model=ProjectAutomationRunView,
)
async def run_workflow_node(
    project_id: str,
    item_id: str,
    workflow_node_id: str,
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAutomationRunView:
    return await project_automation_service.run_for_workflow_node(
        db,
        project_id,
        automation_id,
        item_id,
        workflow_node_id,
        current_user.id,
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


@router.post(
    "/{project_id}/automation-runs/{run_id}/assign",
    response_model=LoopItemResponse,
)
def assign_from_ai_manager(
    project_id: str,
    run_id: str,
    values: ProjectAutomationManagerAssign,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> LoopItemResponse:
    """Apply the assignment selected by a Wework MCP manager."""

    run = db.get(ProjectAutomationRun, run_id)
    if run is None or not run.task_id or str(run.cloud_project_id) != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation run not found")
    require_cloud_project_role(db, project_id, current_user.id, BaseRole.Maintainer)
    if run.created_by_user_id != current_user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Automation manager access denied"
        )
    try:
        assigned = project_automation_execution.assign_from_manager(
            db,
            run_id=run_id,
            user_id=current_user.id,
            project_id=project_id,
            task_id=str(run.task_id),
            assignee_type=values.assignee_type,
            assignee_id=values.assignee_id,
            notify_assignee=values.notify_assignee,
        )
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    from app.tasks.robot_queue_tasks import consume_queues_background

    background_tasks.add_task(consume_queues_background)
    return LoopItemResponse.model_validate(assigned)
