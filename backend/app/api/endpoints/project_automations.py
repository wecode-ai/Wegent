# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wework project automation endpoints."""

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.project_automation import (
    AutomationBugUpsert,
    AutomationBugUpsertResponse,
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
):
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
):
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
):
    return project_automation_service.update(
        db, project_id, automation_id, current_user.id, values
    )


@router.delete("/{project_id}/automations/{automation_id}", status_code=204)
def delete_automation(
    project_id: str,
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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
):
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
):
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
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return project_automation_service.cancel_run(
        db, project_id, run_id, current_user.id
    )


@router.post(
    "/automation-runs/{run_id}/bugs", response_model=AutomationBugUpsertResponse
)
async def upsert_bug(
    run_id: str,
    values: AutomationBugUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    action, item = await project_automation_service.upsert_bug(
        db, run_id, current_user, values
    )
    return {"action": action, "task_id": item.id}
