"""Wework cloud runtime automation API."""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.user import User
from app.schemas.runtime_automation import (
    RuntimeAutomationListResponse,
    RuntimeAutomationMutation,
    RuntimeAutomationResponse,
    RuntimeAutomationRunListResponse,
    RuntimeAutomationRunResponse,
)
from app.schemas.subscription import (
    SubscriptionCreate,
    SubscriptionExecutionTarget,
    SubscriptionExecutionTargetType,
    SubscriptionTaskType,
    SubscriptionTriggerType,
    SubscriptionUpdate,
    SubscriptionVisibility,
)
from app.services.subscription import subscription_service

router = APIRouter()
RUNTIME_AUTOMATION_MARKER = "runtime_automation"


@router.get("", response_model=RuntimeAutomationListResponse)
def list_runtime_automations(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    rows = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Subscription",
            Kind.is_active == True,
        )
        .order_by(Kind.updated_at.desc())
        .all()
    )
    return RuntimeAutomationListResponse(
        items=[
            _automation_response(row)
            for row in rows
            if _runtime_config(row) is not None
        ]
    )


@router.get("/runs", response_model=RuntimeAutomationRunListResponse)
def list_runtime_automation_runs(
    automation_id: str | None = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    query = db.query(BackgroundExecution).filter(
        BackgroundExecution.user_id == current_user.id,
        BackgroundExecution.source_surface == "wework",
    )
    if automation_id:
        subscription_id = _parse_automation_id(automation_id)
        _owned_runtime_automation(db, current_user.id, subscription_id)
        query = query.filter(BackgroundExecution.subscription_id == subscription_id)
    executions = query.order_by(BackgroundExecution.created_at.desc()).limit(200).all()
    return RuntimeAutomationRunListResponse(
        items=[_run_response(execution) for execution in executions]
    )


@router.post(
    "",
    response_model=dict,
    status_code=status.HTTP_201_CREATED,
)
def create_runtime_automation(
    mutation: RuntimeAutomationMutation,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    _validate_timezone(mutation.timezone)
    trigger_type, trigger_config = _subscription_schedule(mutation)
    subscription = subscription_service.create_subscription(
        db=db,
        user_id=current_user.id,
        subscription_in=SubscriptionCreate(
            display_name=mutation.name,
            description=mutation.description,
            task_type=SubscriptionTaskType.EXECUTION,
            visibility=SubscriptionVisibility.PRIVATE,
            trigger_type=trigger_type,
            trigger_config=trigger_config,
            team_id=mutation.task_request.team_id,
            prompt_template=mutation.prompt,
            enabled=mutation.enabled,
            execution_target=SubscriptionExecutionTarget(
                type=SubscriptionExecutionTargetType.CLOUD,
                device_id=mutation.task_request.device_id,
            ),
        ),
    )
    row = _owned_runtime_automation(
        db,
        current_user.id,
        subscription.id,
        require_marker=False,
    )
    _write_runtime_config(row, mutation)
    db.commit()
    db.refresh(row)
    return {"automation": _automation_response(row)}


@router.get("/{automation_id}", response_model=dict)
def get_runtime_automation(
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    row = _owned_runtime_automation(
        db, current_user.id, _parse_automation_id(automation_id)
    )
    return {"automation": _automation_response(row)}


@router.put("/{automation_id}", response_model=dict)
def update_runtime_automation(
    automation_id: str,
    mutation: RuntimeAutomationMutation,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    _validate_timezone(mutation.timezone)
    row = _owned_runtime_automation(
        db, current_user.id, _parse_automation_id(automation_id)
    )
    config = _runtime_config(row)
    if mutation.version is not None and mutation.version != int(
        config.get("version", 1)
    ):
        raise HTTPException(status_code=409, detail="Automation version conflict")
    trigger_type, trigger_config = _subscription_schedule(mutation)
    subscription_service.update_subscription(
        db=db,
        subscription_id=row.id,
        user_id=current_user.id,
        subscription_in=SubscriptionUpdate(
            display_name=mutation.name,
            description=mutation.description,
            trigger_type=trigger_type,
            trigger_config=trigger_config,
            team_id=mutation.task_request.team_id,
            prompt_template=mutation.prompt,
            enabled=mutation.enabled,
            execution_target=SubscriptionExecutionTarget(
                type=SubscriptionExecutionTargetType.CLOUD,
                device_id=mutation.task_request.device_id,
            ),
        ),
    )
    db.refresh(row)
    _write_runtime_config(row, mutation, version=int(config.get("version", 1)) + 1)
    db.commit()
    db.refresh(row)
    return {"automation": _automation_response(row)}


@router.delete("/{automation_id}", response_model=dict)
def delete_runtime_automation(
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    row = _owned_runtime_automation(
        db, current_user.id, _parse_automation_id(automation_id)
    )
    row.is_active = False
    internal = row.json.setdefault("_internal", {})
    internal["enabled"] = False
    row.json["_internal"] = internal
    flag_modified(row, "json")
    db.commit()
    return {"deleted": True}


@router.post("/{automation_id}/toggle", response_model=dict)
def toggle_runtime_automation(
    automation_id: str,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        raise HTTPException(status_code=400, detail="enabled is required")
    row = _owned_runtime_automation(
        db, current_user.id, _parse_automation_id(automation_id)
    )
    subscription_service.toggle_subscription(
        db=db,
        subscription_id=row.id,
        user_id=current_user.id,
        enabled=enabled,
    )
    db.refresh(row)
    return {"automation": _automation_response(row)}


@router.post("/{automation_id}/run", response_model=dict)
def run_runtime_automation_now(
    automation_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    row = _owned_runtime_automation(
        db, current_user.id, _parse_automation_id(automation_id)
    )
    has_active_run = (
        db.query(BackgroundExecution.id)
        .filter(
            BackgroundExecution.subscription_id == row.id,
            BackgroundExecution.status.in_(["PENDING", "RUNNING"]),
        )
        .first()
        is not None
    )
    execution = subscription_service.create_execution(
        db,
        subscription=row,
        user_id=current_user.id,
        trigger_type="manual",
        trigger_reason="Manual Wework automation run",
    )
    model = (
        db.query(BackgroundExecution)
        .filter(BackgroundExecution.id == execution.id)
        .first()
    )
    model.source_surface = "wework"
    model.runtime_device_id = _runtime_config(row)["task_request"].get("deviceId")
    if has_active_run:
        model.status = "SKIPPED"
        model.error_message = "Skipped because another automation run is active"
        model.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    if not has_active_run:
        subscription_service.dispatch_background_execution(row, execution)
    db.refresh(model)
    return {"run": _run_response(model)}


def _owned_runtime_automation(
    db: Session,
    user_id: int,
    subscription_id: int,
    *,
    require_marker: bool = True,
) -> Kind:
    row = (
        db.query(Kind)
        .filter(
            Kind.id == subscription_id,
            Kind.user_id == user_id,
            Kind.kind == "Subscription",
            Kind.is_active == True,
        )
        .first()
    )
    if not row or (require_marker and _runtime_config(row) is None):
        raise HTTPException(status_code=404, detail="Automation not found")
    return row


def _write_runtime_config(
    row: Kind,
    mutation: RuntimeAutomationMutation,
    *,
    version: int = 1,
) -> None:
    internal = row.json.setdefault("_internal", {})
    internal[RUNTIME_AUTOMATION_MARKER] = {
        "version": version,
        "timezone": mutation.timezone,
        "conversation_mode": mutation.conversation_mode,
        "notification_policy": mutation.notification_policy,
        "task_request": mutation.task_request.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        ),
        "continuation_payload": mutation.continuation_payload,
    }
    internal["source_surface"] = "wework"
    row.json["_internal"] = internal
    flag_modified(row, "json")


def _runtime_config(row: Kind) -> dict | None:
    value = row.json.get("_internal", {}).get(RUNTIME_AUTOMATION_MARKER)
    return value if isinstance(value, dict) else None


def _automation_response(row: Kind) -> RuntimeAutomationResponse:
    internal = row.json["_internal"]
    config = _runtime_config(row) or {}
    spec = row.json.get("spec", {})
    return RuntimeAutomationResponse(
        id=f"cloud:{row.id}",
        version=int(config.get("version", 1)),
        name=spec.get("displayName") or row.name,
        description=spec.get("description") or "",
        prompt=spec.get("promptTemplate") or "",
        schedule=_automation_schedule(internal, spec),
        timezone=config.get("timezone", "UTC"),
        enabled=bool(internal.get("enabled", True)),
        conversationMode=config.get("conversation_mode", "independent"),
        notificationPolicy=config.get("notification_policy", "all_runs"),
        taskRequest=config.get("task_request", {}),
        continuationPayload=config.get("continuation_payload"),
        nextRunAt=_parse_datetime(internal.get("next_execution_time")),
        lastRunAt=_parse_datetime(internal.get("last_execution_time")),
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


def _run_response(execution: BackgroundExecution) -> RuntimeAutomationRunResponse:
    status_map = {
        "completed": "succeeded",
        "completed_silent": "succeeded",
    }
    normalized_status = execution.status.lower()
    return RuntimeAutomationRunResponse(
        id=f"cloud-run:{execution.id}",
        automationId=f"cloud:{execution.subscription_id}",
        scheduledFor=execution.scheduled_for or execution.created_at,
        trigger=execution.trigger_type,
        status=status_map.get(normalized_status, normalized_status),
        taskId=execution.runtime_task_id,
        deviceId=execution.runtime_device_id,
        error=execution.error_message or None,
        createdAt=execution.created_at,
        updatedAt=execution.updated_at,
    )


def _subscription_schedule(
    mutation: RuntimeAutomationMutation,
) -> tuple[SubscriptionTriggerType, dict]:
    schedule = mutation.schedule
    if schedule.type == "cron":
        return SubscriptionTriggerType.CRON, {
            "expression": schedule.expression,
            "timezone": mutation.timezone,
        }
    if schedule.type == "interval":
        return SubscriptionTriggerType.INTERVAL, {
            "value": schedule.value,
            "unit": schedule.unit,
        }
    return SubscriptionTriggerType.ONE_TIME, {
        "execute_at": schedule.execute_at.isoformat(),
    }


def _automation_schedule(internal: dict, spec: dict) -> dict:
    trigger_type = internal.get("trigger_type")
    trigger = spec.get("trigger", {})
    config = trigger.get(trigger_type, {})
    if trigger_type == "one_time":
        return {
            "type": "one_time",
            "executeAt": config.get("execute_at") or config.get("executeAt"),
        }
    return {"type": trigger_type, **config}


def _parse_automation_id(value: str) -> int:
    normalized = value.removeprefix("cloud:")
    try:
        return int(normalized)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Automation not found") from exc


def _parse_datetime(value: str | datetime | None) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _validate_timezone(value: str) -> None:
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:
        raise HTTPException(status_code=400, detail="Invalid IANA timezone") from exc
