# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wework project automation endpoints."""

from fastapi import APIRouter, BackgroundTasks, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.delivery import ProjectAutomationRun
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationRunView,
    ProjectAutomationUpdate,
    ProjectAutomationView,
)
from app.services.project_automations import project_automation_service

router = APIRouter()


@router.get("/{project_id}/automations", response_model=list[ProjectAutomationView])
def list_automations(
    project_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectAutomationView]:
    return project_automation_service.list(db, project_id, current_user.id)


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


@router.delete("/{project_id}/automations/{automation_id}", status_code=204)
def delete_automation(
    project_id: str,
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    project_automation_service.delete(db, project_id, automation_id, current_user.id)
    return Response(status_code=204)


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
def cancel_run(
    project_id: str,
    run_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAutomationRunView:
    run = db.get(ProjectAutomationRun, run_id)
    execution = (
        db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == run.task_id)
        .order_by(LoopItemExecution.id.desc())
        .first()
        if run is not None and run.task_id
        else None
    )
    result = project_automation_service.cancel_run(
        db, project_id, run_id, current_user.id
    )
    if (
        execution is not None
        and execution.runtime_device_id
        and execution.runtime_task_id
    ):
        from app.tasks.robot_queue_tasks import emit_runtime_cancels

        background_tasks.add_task(emit_runtime_cancels, [execution])
    return result
