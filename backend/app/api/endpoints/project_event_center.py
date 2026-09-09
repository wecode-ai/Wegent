# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authenticated board event center and Runtime decision endpoints."""

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user, get_current_user_jwt_apikey_tasktoken
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.project_event_center import (
    EventCenterConfig,
    EventReply,
    EventRoutingDecision,
    EventSubmission,
    ExternalReference,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.project_event_center import project_event_center_service as service

router = APIRouter()


@router.get("/{project_id}/event-center")
def get_config(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return service.config(db, project_id, user.id)


@router.put("/{project_id}/event-center")
def configure(
    project_id: str,
    values: EventCenterConfig,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return service.configure(db, project_id, user.id, values)


@router.get("/{project_id}/events")
def list_events(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    return service.list(db, project_id, user.id)


@router.post("/{project_id}/events", status_code=201)
def submit(
    project_id: str,
    values: EventSubmission,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return service.view(service.submit(db, project_id, user.id, values))


@router.post("/{project_id}/events/{event_id}/reply")
def reply(
    project_id: str,
    event_id: str,
    values: EventReply,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return service.reply(db, project_id, event_id, user.id, values)


@router.post("/{project_id}/events/{event_id}/retry")
async def retry(
    project_id: str,
    event_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    from app.services.project_event_handoff import resume_handoff

    require_cloud_project_role(db, project_id, user.id, BaseRole.Developer)
    event = service.get(db, project_id, event_id, user.id, lock=True)
    if event.status == "handoff_failed":
        await resume_handoff(db, event.id)
    elif event.status in {"failed", "waiting_configuration"}:
        service.enqueue(db, event)
        db.commit()
    else:
        raise HTTPException(409, "Event is not waiting for recovery")
    return service.view(event)


@router.get("/{project_id}/events/{event_id}/context")
def context(
    project_id: str,
    event_id: str,
    execution_id: int = Header(alias="X-Event-Execution-Id"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> dict:
    return service.context(db, project_id, event_id, user.id, execution_id)


@router.post("/{project_id}/events/{event_id}/decision")
async def decide(
    project_id: str,
    event_id: str,
    values: EventRoutingDecision,
    execution_id: int = Header(alias="X-Event-Execution-Id"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> dict:
    return await service.decide(db, project_id, event_id, user.id, execution_id, values)


@router.post("/{project_id}/events/references/{issue_id}")
def register_reference(
    project_id: str,
    issue_id: str,
    values: ExternalReference,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> dict:
    result = service.bind_reference(db, project_id, issue_id, user.id, values)
    db.commit()
    return result
