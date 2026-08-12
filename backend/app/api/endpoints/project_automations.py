# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wework project automation endpoints."""

import hashlib
import hmac
import json
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Header,
    HTTPException,
    Request,
    Response,
    status,
)
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.delivery import (
    CloudProject,
    ProjectAutomationRule,
    ProjectAutomationRun,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationRunView,
    ProjectAutomationUpdate,
    ProjectAutomationView,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.project_automations import (
    ProjectAutomationEvent,
    project_automation_processor,
    project_automation_service,
)
from shared.utils.crypto import decrypt_sensitive_data_with_embedded_iv

router = APIRouter()


@router.post(
    "/automation-events/{webhook_event_id}", status_code=status.HTTP_202_ACCEPTED
)
async def trigger_automation_event(
    webhook_event_id: str,
    request: Request,
    x_hub_signature_256: str = Header(default="", alias="X-Hub-Signature-256"),
    x_gitlab_token: str = Header(default="", alias="X-Gitlab-Token"),
    db: Session = Depends(get_db),
) -> dict[str, int | str]:
    rule = db.get(ProjectAutomationRule, webhook_event_id)
    if rule is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation event not found")
    project_automation_service._rule(db, str(rule.cloud_project_id), webhook_event_id)
    project = db.get(CloudProject, rule.cloud_project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation event not found")
    raw_body = await request.body()
    _verify_webhook_signature(
        rule,
        project.task_provider,
        raw_body,
        x_hub_signature_256=x_hub_signature_256,
        x_gitlab_token=x_gitlab_token,
    )
    try:
        payload = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Invalid webhook payload"
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid webhook payload")
    event_name = str(payload.get("event_type") or payload.get("eventType") or "")
    if not event_name and isinstance(payload.get("issue"), dict):
        event_name = f"issues.{payload.get('action')}"
    if not event_name and payload.get("object_kind") == "issue":
        attributes = payload.get("object_attributes")
        if isinstance(attributes, dict):
            event_name = f"issue.{attributes.get('action')}"
    if event_name not in {"task.created", "issues.opened", "issue.open"}:
        return {"status": "ignored", "dispatched": 0}
    issue = payload.get("issue")
    if not isinstance(issue, dict):
        object_attributes = payload.get("object_attributes")
        issue = object_attributes if isinstance(object_attributes, dict) else payload
    number = issue.get("number") or issue.get("iid")
    if not number or project is None or not project.project_key:
        return {"status": "ignored", "dispatched": 0}
    subject_id = f"{project.project_key}-{number}"
    source = project.task_provider
    dispatched = await project_automation_processor.process(
        db,
        ProjectAutomationEvent(
            event_type="task.created",
            project_id=str(rule.cloud_project_id),
            subject_id=subject_id,
            source=source,
            actor_user_id=rule.created_by_user_id,
            payload=issue,
        ),
        automation_id=webhook_event_id,
    )
    return {"status": "accepted", "dispatched": dispatched}


def _verify_webhook_signature(
    rule: ProjectAutomationRule,
    provider: str,
    raw_body: bytes,
    *,
    x_hub_signature_256: str,
    x_gitlab_token: str,
) -> None:
    metadata = rule.metadata_json if isinstance(rule.metadata_json, dict) else {}
    encrypted = metadata.get("webhook_secret_encrypted")
    secret = (
        decrypt_sensitive_data_with_embedded_iv(encrypted)
        if isinstance(encrypted, str) and encrypted
        else None
    )
    if not secret:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Webhook secret unavailable")
    if provider == "github":
        expected = (
            "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
        )
        valid = hmac.compare_digest(x_hub_signature_256, expected)
    elif provider == "gitlab":
        valid = hmac.compare_digest(x_gitlab_token, secret)
    else:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Webhook provider unsupported"
        )
    if not valid:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid webhook signature")


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
