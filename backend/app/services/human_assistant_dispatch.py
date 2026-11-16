"""Assignment-owned personal assistant intents using the existing execution ledger."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.timezone import database_datetime_as_utc
from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemComment,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.services.loop_item_events import queue_loop_item_changed
from shared.telemetry.decorators import trace_async

if TYPE_CHECKING:
    from app.schemas.delivery import LoopItemTaskBind
    from app.services.issue_assignments import AssignmentEvent

DISPATCH_KEY = "human_assistant_dispatch"
TERMINAL = {"completed", "failed", "cancelled"}
_PENDING_CANCELLATIONS = "human_assistant_cancellations"


def enabled() -> bool:
    return settings.HUMAN_ASSIGNMENT_ASSISTANT_DISPATCH_ENABLED


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _endpoint(db: Session, owner: int, item: LoopItem) -> tuple[Kind, dict] | None:
    devices = (
        db.query(Kind)
        .filter_by(kind="Device", namespace="default", user_id=owner, is_active=True)
        .order_by(Kind.updated_at.desc(), Kind.id.desc())
    )
    project = {"id": str(item.cloud_project_id), "store": "cloud"}
    for device in devices:
        spec = (device.json or {}).get("spec", {})
        if spec.get("workspaceOwnerId"):
            continue
        declaration = spec.get("personalAssistantDispatch", {})
        for role in declaration.get("roles", []):
            source = role.get("collaboration") or {}
            if (
                role.get("id") != "@primary"
                or role.get("userId") != owner
                or not role.get("enabled")
                or not source.get("enabled")
                or project in source.get("excludedProjects", [])
                or not (
                    source.get("allProjects") or project in source.get("projects", [])
                )
            ):
                continue
            policy = {
                **(role.get("handlingPolicy") or {}),
                **(source.get("policy") or {}),
            }
            for override in source.get("projectPolicies", []):
                if (
                    override.get("id") == project["id"]
                    and override.get("store") == "cloud"
                ):
                    policy.update(override.get("policy") or {})
            if policy.get("automatic") is False:
                continue
            tags = source.get("tags") or []
            item_tags = (item.metadata_json or {}).get("tags") or []
            if tags and not set(tags).intersection(item_tags):
                continue
            return device, role
    return None


def _save(event: AssignmentEvent, dispatch: dict) -> None:
    metadata = dict(event.comment.metadata_json or {})
    metadata[DISPATCH_KEY] = dispatch
    event.comment.metadata_json = metadata


def ensure_dispatch(db: Session, event: AssignmentEvent) -> dict | None:
    """Create once under the Issue lock, independently of notification delivery."""
    if not enabled() or event.member_type != "human" or event.workflow_step:
        return None
    if event.metadata.get("trigger") in {"default", "collaboration_round"}:
        return None
    item = db.get(LoopItem, event.loop_item_id)
    if item is None or item.status in {"completed", "deleted", "cancelled"}:
        return None
    project = db.get(CloudProject, item.cloud_project_id)
    metadata = item.metadata_json or {}
    if (
        project is None
        or project.task_provider != "local"
        or any(
            metadata.get(key)
            for key in ("workflow", "external_index", "external_shadow")
        )
    ):
        return None
    # Current reads preserve one intent when two device heartbeats resolve it.
    db.refresh(event.comment, with_for_update=True)
    previous = (event.comment.metadata_json or {}).get(DISPATCH_KEY)
    if isinstance(previous, dict):
        return previous
    version = int(event.metadata.get("assignment_version") or 1)
    key = f"{item.cloud_project_id}:{item.id}:{event.id}:{version}"
    now = _now().isoformat() + "Z"
    dispatch = {
        "dispatchId": str(uuid5(NAMESPACE_URL, f"wegent:human-assistant:{key}")),
        "projectId": str(item.cloud_project_id),
        "issueId": item.id,
        "assignmentId": event.id,
        "assignmentVersion": version,
        "ownerUserId": int(event.member_id),
        "endpointRef": None,
        "dispatchState": "no_authorized_assistant",
        "executionId": None,
        "reasonCode": "no_authorized_assistant",
        "idempotencyKey": key,
        "createdAt": now,
        "updatedAt": now,
    }
    _save(event, dispatch)
    return _resolve_dispatch(db, item, event, dispatch)


def _resolve_dispatch(
    db: Session, item: LoopItem, event: AssignmentEvent, dispatch: dict
) -> dict:
    if dispatch["dispatchState"] in TERMINAL | {"superseded"}:
        return dispatch
    if dispatch.get("executionId"):
        return dispatch
    endpoint = _endpoint(db, int(event.member_id), item)
    if endpoint is None:
        dispatch = {
            **dispatch,
            "dispatchState": "no_authorized_assistant",
            "reasonCode": "no_authorized_assistant",
        }
    else:
        device, role = endpoint
        dispatch = {
            **dispatch,
            "endpointRef": f"wework-local:{device.name}:@primary",
            "dispatchState": "waiting_device",
            "reasonCode": "waiting_device",
        }
        if not dispatch.get("executionId") and item.status != "completed":
            execution = LoopItemExecution(
                loop_item_id=item.id,
                cloud_project_id=str(item.cloud_project_id),
                executor_owner_user_id=int(event.member_id),
                agent_id="",
                team_id=0,
                assigner_user_id=int(event.member_id),
                execution_environment="local",
                execution_device_id=device.name,
                status="waiting_runtime",
                queued_at=_now(),
                max_retries=0,
                execution_scope=f"human-assistant:{dispatch['dispatchId']}",
                execution_note="Waiting for the owner's authorized default assistant",
                execution_payload=json.dumps(
                    {
                        "schema_version": 2,
                        "runtime_selection": {"executor_kind": "human_assistant"},
                        "origin_context": {
                            "human_assistant_dispatch": dispatch["dispatchId"],
                            "assignment_id": event.id,
                            "assignment_version": dispatch["assignmentVersion"],
                            "owner_user_id": int(event.member_id),
                            "assigned_by_user_id": event.assigned_by_user_id,
                            "stand_in_id": role["id"],
                            "publish_policy": "summary_and_evidence_only",
                        },
                    }
                ),
            )
            db.add(execution)
            db.flush()
            dispatch["executionId"] = str(execution.id)
    dispatch["updatedAt"] = _now().isoformat() + "Z"
    _save(event, dispatch)
    queue_loop_item_changed(
        db,
        item_id=item.id,
        reason="human_assistant_dispatch",
        actor_user_id=int(event.member_id),
    )
    db.flush()
    return dispatch


def current_dispatch(db: Session, item: LoopItem) -> dict | None:
    return current_dispatches(db, [item]).get(item.id)


def current_dispatches(db: Session, items: list[LoopItem]) -> dict[str, dict]:
    """Project assignment intents in batches for Issue lists and My Work."""
    from app.services.issue_assignments import issue_assignment_service

    candidates = [item for item in items if item.assignee_user_id]
    assignments = issue_assignment_service.active_for_issues(
        db, [item.id for item in candidates]
    )
    dispatches = {}
    for item in candidates:
        for assignment in assignments[item.id]:
            if (
                assignment.member_type == "human"
                and assignment.member_id == str(item.assignee_user_id)
                and not assignment.workflow_step
            ):
                dispatch = (assignment.comment.metadata_json or {}).get(DISPATCH_KEY)
                if isinstance(dispatch, dict):
                    dispatches[item.id] = dispatch
    execution_ids = {
        dispatch["executionId"]
        for dispatch in dispatches.values()
        if dispatch.get("executionId")
    }
    executions = (
        {
            str(row.id): row
            for row in db.query(LoopItemExecution).filter(
                LoopItemExecution.id.in_(execution_ids)
            )
        }
        if execution_ids
        else {}
    )
    return {
        item_id: _dispatch_view(
            db, dispatch, executions.get(str(dispatch.get("executionId")))
        )
        for item_id, dispatch in dispatches.items()
    }


def _dispatch_view(
    db: Session, dispatch: dict, execution: LoopItemExecution | None
) -> dict:
    result = dict(dispatch)
    if execution is not None and execution.status != "waiting_runtime":
        result["dispatchState"] = {
            "claimed": "queued",
            "cancel_requested": "cancelling",
        }.get(execution.status, execution.status)
        result["reasonCode"] = (
            None
            if execution.status in {"claimed", "running", "completed"}
            else execution.termination_reason or result.get("reasonCode")
        )
        result["updatedAt"] = database_datetime_as_utc(
            db, execution.updated_at
        ).isoformat()
    return result


def cancel_assignment_dispatch(
    db: Session, event: AssignmentEvent, reason: str = "superseded"
) -> None:
    dispatch = (event.comment.metadata_json or {}).get(DISPATCH_KEY)
    if not isinstance(dispatch, dict) or dispatch["dispatchState"] in TERMINAL | {
        "superseded"
    }:
        return
    _save(
        event,
        {
            **dispatch,
            "dispatchState": "cancelled",
            "reasonCode": reason,
            "updatedAt": _now().isoformat() + "Z",
        },
    )
    queue_loop_item_changed(
        db,
        item_id=event.loop_item_id,
        reason="human_assistant_dispatch",
        actor_user_id=int(event.member_id),
    )
    db.flush()
    execution = (
        db.get(LoopItemExecution, dispatch.get("executionId"))
        if dispatch.get("executionId")
        else None
    )
    if execution and execution.status not in TERMINAL:
        from app.services.loop_item_executions.service import (
            loop_item_execution_service,
        )

        cancelled = loop_item_execution_service.cancel(
            db, execution_id=execution.id, note=reason, commit=False
        )
        if cancelled.status == "cancel_requested":
            db.info.setdefault(_PENDING_CANCELLATIONS, set()).add(cancelled.id)


def execution_current(db: Session, execution: LoopItemExecution) -> bool:
    """Check live assignment authority before admission and every Runtime update."""
    item = db.get(LoopItem, execution.loop_item_id)
    if (
        item is None
        or item.status in {"completed", "deleted", "cancelled"}
        or not loop_datetime_value_is_unset(item.deleted_at)
        or item.assignee_user_id != execution.executor_owner_user_id
    ):
        return False
    from app.services.issue_assignments import issue_assignment_service

    event = issue_assignment_service.active(
        db,
        issue_id=item.id,
        member_type="human",
        member_id=str(execution.executor_owner_user_id),
        workflow_step=None,
    )
    if event is not None:
        db.refresh(event.comment, with_for_update=True)
    if event is None or event.id != execution.runtime_origin_context.get(
        "assignment_id"
    ):
        return False
    dispatch = (event.comment.metadata_json or {}).get(DISPATCH_KEY)
    if not isinstance(dispatch, dict) or dispatch.get("dispatchState") in TERMINAL | {
        "superseded",
        "cancelling",
    }:
        return False
    if str(dispatch.get("executionId")) != str(execution.id) or dispatch.get(
        "assignmentVersion"
    ) != execution.runtime_origin_context.get("assignment_version"):
        return False
    from app.models.user import User
    from app.services.cloud_projects.access import require_cloud_project_role
    from app.services.collaboration_permissions import collaboration_permission_service
    from app.services.loop_items.access import can_view_item

    owner = db.get(User, execution.executor_owner_user_id)
    if owner is None or not owner.is_active:
        return False
    decision = collaboration_permission_service.check(
        db, owner.id, "execute", item.cloud_project_id
    )
    if not decision.allowed:
        return False
    try:
        access = require_cloud_project_role(db, item.cloud_project_id, owner.id)
    except HTTPException:
        return False
    return can_view_item(db, access, item, owner.id)


def claim_for_binding(
    db: Session, item: LoopItem, values: LoopItemTaskBind, user_id: int
) -> str | None:
    """Use existing task admission as the atomic personal-assistant claim."""
    if not values.human_assistant_dispatch_id:
        return None
    if not values.human_assignment_id or not values.assignment_id:
        raise HTTPException(422, "Assistant dispatch requires its assignment")
    from app.services.device.identity import resolve_owned_device_alias
    from app.services.issue_assignments import issue_assignment_service

    submitted = db.get(LoopItemComment, values.assignment_id)
    submitted_dispatch = (
        (submitted.metadata_json or {}).get(DISPATCH_KEY) if submitted else None
    )
    event = issue_assignment_service.active(
        db,
        issue_id=item.id,
        member_type="human",
        member_id=str(user_id),
        workflow_step=None,
    )
    if event is not None:
        db.refresh(event.comment, with_for_update=True)
    dispatch = (event.comment.metadata_json or {}).get(DISPATCH_KEY) if event else None
    if isinstance(submitted_dispatch, dict) and (
        event is None or event.id != values.assignment_id
    ):
        raise HTTPException(409, "Assistant assignment is no longer current")
    if not isinstance(dispatch, dict):
        raise HTTPException(409, "Assistant dispatch is unavailable")
    if dispatch["dispatchId"] != values.human_assistant_dispatch_id:
        raise HTTPException(409, "Assistant dispatch is no longer current")
    if dispatch.get("dispatchState") in TERMINAL | {"superseded", "cancelling"}:
        raise HTTPException(409, "Assistant dispatch is no longer active")
    from app.services.collaboration_human_assignments import direct_human_assignment_id

    if values.human_assignment_id != direct_human_assignment_id(
        issue_id=item.id, assignment_id=event.id
    ):
        raise HTTPException(409, "Assistant assignment identity does not match")
    if (
        event.id != values.assignment_id
        or item.assignee_user_id != user_id
        or item.status == "completed"
    ):
        raise HTTPException(409, "Assistant assignment is no longer current")
    endpoint = _endpoint(db, user_id, item)
    device = resolve_owned_device_alias(db, user_id=user_id, device_id=values.device_id)
    if endpoint is None or device is None or endpoint[0].id != device.id:
        raise HTTPException(403, "Default assistant is not authorized on this device")
    dispatch = _resolve_dispatch(db, item, event, dispatch)
    execution = db.get(LoopItemExecution, dispatch["executionId"])
    if not execution_current(db, execution):
        raise HTTPException(403, "Assistant execution permission is unavailable")
    if execution.status == "waiting_runtime" and not enabled():
        raise HTTPException(409, "Automatic assistant dispatch is disabled")
    if execution.status != "waiting_runtime":
        if (
            execution.runtime_task_id == values.task_id
            and execution.runtime_device_id == values.device_id
            and execution.status not in TERMINAL
        ):
            return str(execution.id)
        raise HTTPException(409, "Assistant assignment already claimed")
    execution.status = "claimed"
    execution.execution_device_id = device.name
    execution.runtime_device_id = values.device_id
    execution.runtime_task_id = values.task_id
    execution.claimed_at = _now()
    execution.start_requested_at = _now()
    execution.lease_expires_at = _now() + timedelta(minutes=5)
    execution.execution_note = ""
    _save(event, {**dispatch, "dispatchState": "queued", "reasonCode": None})
    queue_loop_item_changed(
        db, item_id=item.id, reason="human_assistant_dispatch", actor_user_id=user_id
    )
    db.flush()
    return str(execution.id)


@sqlalchemy_event.listens_for(Session, "after_rollback")
def _discard_cancellations(db: Session) -> None:
    db.info.pop(_PENDING_CANCELLATIONS, None)


@sqlalchemy_event.listens_for(Session, "after_commit")
def _schedule_cancellations(db: Session) -> None:
    pending = db.info.pop(_PENDING_CANCELLATIONS, set())
    if pending:
        from app.core.async_utils import schedule_async_task

        schedule_async_task(_send_cancellations, pending)


@trace_async("human_assistant.cancel", tracer_name="backend")
async def _send_cancellations(execution_ids: set[int]) -> None:
    from app.core.async_utils import run_in_threadpool_with_cleanup

    await run_in_threadpool_with_cleanup(_send_cancellations_sync, execution_ids)


def _send_cancellations_sync(execution_ids: set[int]) -> None:
    from app.db.session import SessionLocal
    from app.services.loop_item_executions.cancellation import (
        request_execution_cancellations,
    )

    with SessionLocal() as db:
        rows = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.id.in_(execution_ids),
                LoopItemExecution.status == "cancel_requested",
            )
            .all()
        )
        request_execution_cancellations(rows)


def publish_result(
    db: Session, execution: LoopItemExecution, content: str | None, terminal_status: str
):
    """Publish only the final summary with personal provenance, never tool events."""
    if terminal_status == "cancelled" or not execution_current(db, execution):
        return None
    from app.models.project_chat_message import ProjectChatMessage
    from app.models.user import User

    key = f"human-assistant-result:{execution.id}"
    existing = db.query(ProjectChatMessage).filter_by(message_id=key).first()
    if existing:
        return existing
    owner = db.get(User, execution.executor_owner_user_id)
    message = ProjectChatMessage(
        message_id=key,
        client_message_id=key,
        project_id=execution.cloud_project_id,
        task_id=execution.loop_item_id,
        sender_type="user",
        sender_id=str(execution.executor_owner_user_id),
        sender_name=owner.user_name if owner else "",
        message_type="text",
        content=content or "",
        status=terminal_status,
        metadata_json={
            "activity_type": "human_assistant_result",
            "execution_id": str(execution.id),
            "assignment_id": execution.runtime_origin_context["assignment_id"],
            "provenance": {
                "origin": "ai_generated",
                "owner_user_id": execution.executor_owner_user_id,
                "publisher_user_id": execution.executor_owner_user_id,
                "confirmation_status": "unconfirmed",
            },
        },
    )
    db.add(message)
    db.flush()
    return message
