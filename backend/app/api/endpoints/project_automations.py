# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wework project automation endpoints."""

import hashlib
import hmac
import json
import logging
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
from app.core.project_automation_secrets import decrypt_webhook_secret
from app.core.security import get_current_user
from app.models.delivery import (
    CloudProject,
    ProjectAutomationRule,
    ProjectAutomationRun,
)
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemResponse
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationManagerAssign,
    ProjectAutomationRunView,
    ProjectAutomationUpdate,
    ProjectAutomationView,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.project_automation_execution import project_automation_execution
from app.services.project_automations import (
    ProjectAutomationEvent,
    project_automation_processor,
    project_automation_service,
)

router = APIRouter()
logger = logging.getLogger(__name__)


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
    logger.info(
        "[ProjectAutomationWebhook] Received event rule=%s content_type=%s",
        webhook_event_id,
        request.headers.get("content-type", ""),
    )
    rule = db.get(ProjectAutomationRule, webhook_event_id)
    if rule is None:
        logger.warning(
            "[ProjectAutomationWebhook] Rule not found rule=%s", webhook_event_id
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation event not found")
    project_automation_service._rule(db, str(rule.cloud_project_id), webhook_event_id)
    project = db.get(CloudProject, rule.cloud_project_id)
    if project is None:
        logger.warning(
            "[ProjectAutomationWebhook] Project not found rule=%s project=%s",
            webhook_event_id,
            rule.cloud_project_id,
        )
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
    if project.task_provider == "github" and isinstance(payload.get("issue"), dict):
        event_name = f"issues.{payload.get('action')}"
    elif project.task_provider == "gitlab" and payload.get("object_kind") == "issue":
        attributes = payload.get("object_attributes")
        action = attributes.get("action") if isinstance(attributes, dict) else None
        event_name = f"issue.{action}"
    else:
        event_name = str(payload.get("event_type") or payload.get("eventType") or "")
    if event_name not in {"task.created", "issues.opened", "issue.open"}:
        logger.info(
            "[ProjectAutomationWebhook] Ignored event rule=%s provider=%s "
            "object_kind=%s event_name=%s",
            webhook_event_id,
            project.task_provider,
            payload.get("object_kind"),
            event_name,
        )
        return {"status": "ignored", "dispatched": 0}
    issue = payload.get("issue")
    if not isinstance(issue, dict):
        object_attributes = payload.get("object_attributes")
        issue = object_attributes if isinstance(object_attributes, dict) else payload
    issue = external_loop_item_provider.normalize_issue_payload(issue)
    number = issue.get("number") or issue.get("iid")
    if not number or project is None or not project.project_key:
        logger.info(
            "[ProjectAutomationWebhook] Ignored event without subject rule=%s "
            "provider=%s has_number=%s has_project_key=%s",
            webhook_event_id,
            project.task_provider,
            bool(number),
            bool(project.project_key),
        )
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
    logger.info(
        "[ProjectAutomationWebhook] Processed event rule=%s provider=%s "
        "subject=%s dispatched=%s",
        webhook_event_id,
        source,
        subject_id,
        dispatched,
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
    try:
        secret = decrypt_webhook_secret(
            encrypted,
            project_id=str(rule.cloud_project_id),
            automation_id=str(rule.id),
        )
    except ValueError:
        secret = None
    if not secret:
        logger.warning(
            "[ProjectAutomationWebhook] Secret unavailable rule=%s provider=%s",
            rule.id,
            provider,
        )
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
        logger.warning(
            "[ProjectAutomationWebhook] Signature rejected rule=%s provider=%s",
            rule.id,
            provider,
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid webhook signature")
    logger.info(
        "[ProjectAutomationWebhook] Signature accepted rule=%s provider=%s",
        rule.id,
        provider,
    )


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
    "/{project_id}/automations/{automation_id}/rotate-webhook-secret",
    response_model=ProjectAutomationView,
)
def rotate_automation_webhook_secret(
    project_id: str,
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectAutomationView:
    return project_automation_service.rotate_webhook_secret(
        db, project_id, automation_id, current_user.id
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
    current_user: User = Depends(get_current_user),
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
        )
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    from app.tasks.robot_queue_tasks import consume_queues_background

    background_tasks.add_task(consume_queues_background)
    return LoopItemResponse.model_validate(assigned)
