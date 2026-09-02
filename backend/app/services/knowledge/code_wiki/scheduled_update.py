# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project Code Wiki scheduled updates onto the generic subscription scheduler."""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.wiki_config import wiki_settings
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.user import User
from app.schemas.knowledge import (
    CodeWikiAutomaticUpdate,
    CodeWikiAutomaticUpdateExecution,
    CodeWikiAutomaticUpdateRequest,
)
from app.schemas.subscription import BackgroundExecutionStatus
from app.services.knowledge.code_wiki.generation import (
    GenerationInFlight,
    current_run_state,
)
from app.services.knowledge.code_wiki.runner import (
    CodeWikiRunError,
    source_of,
    start_run,
)
from app.services.knowledge.code_wiki.source import (
    SourceAccessDenied,
    SourceRepository,
    assert_user_can_read_source,
)
from app.services.knowledge.code_wiki.version_store import STALE_RUN_AFTER_HOURS
from app.services.subscription import subscription_service

RUNNER_SPEC_KEY = "executionPrincipalUserId"
SUBSCRIPTION_SPEC_KEY = "scheduledUpdateSubscriptionId"
CODE_WIKI_REF_KEY = "codeWikiRef"
SCHEDULED_UPDATE_TIMEOUT_SECONDS = int(STALE_RUN_AFTER_HOURS * 60 * 60)


def code_wiki_id(subscription: Kind) -> int | None:
    """Return the explicitly referenced Code Wiki id, if this is its scheduler row."""
    if subscription.kind != "Subscription":
        return None
    value = (
        (subscription.json or {}).get("spec", {}).get(CODE_WIKI_REF_KEY, {}).get("id")
    )
    return value if isinstance(value, int) and value > 0 else None


def is_code_wiki_scheduled_update(subscription: Kind) -> bool:
    return code_wiki_id(subscription) is not None


def reject_code_wiki_scheduled_update(subscription: Kind, *, detail: str) -> None:
    """Keep internal scheduler rows behind the Code Wiki management boundary."""
    if is_code_wiki_scheduled_update(subscription):
        raise HTTPException(status_code=409, detail=detail)


def scheduled_update_for(db: Session, knowledge_base: Kind | int) -> Kind | None:
    """Resolve a plan only through the authoritative id stored on the Code Wiki."""
    if isinstance(knowledge_base, int):
        knowledge_base = db.get(Kind, knowledge_base)
    if knowledge_base is None:
        return None
    subscription_id = (
        (knowledge_base.json or {}).get("spec", {}).get(SUBSCRIPTION_SPEC_KEY)
    )
    if not isinstance(subscription_id, int) or subscription_id <= 0:
        return None
    subscription = db.get(Kind, subscription_id)
    if (
        subscription is None
        or not subscription.is_active
        or code_wiki_id(subscription) != knowledge_base.id
    ):
        return None
    return subscription


def first_scheduled_time(
    data: CodeWikiAutomaticUpdateRequest, now: datetime | None = None
) -> datetime:
    """Return the first allowed slot as naive UTC; creation day is never eligible."""
    try:
        local_tz = ZoneInfo(data.timezone)
    except Exception as exc:
        raise ValueError(f"Invalid IANA timezone: {data.timezone}") from exc
    current = (now or datetime.now(timezone.utc)).astimezone(local_tz)
    tomorrow = current.date() + timedelta(days=1)
    candidate = datetime.combine(
        tomorrow, datetime.min.time(), tzinfo=local_tz
    ).replace(hour=data.hour, minute=data.minute)
    if data.cadence in {"weekly", "biweekly", "four_weeks"}:
        candidate += timedelta(days=(data.weekday - candidate.weekday()) % 7)
    return candidate.astimezone(timezone.utc).replace(tzinfo=None)


def validate_runner(db: Session, knowledge_base: Kind, user_id: int) -> User:
    return validate_runner_for_source(
        db, user_id=user_id, source=source_of(knowledge_base)
    )


def validate_runner_for_source(
    db: Session, *, user_id: int, source: SourceRepository
) -> User:
    runner = db.get(User, user_id)
    if runner is None or not runner.is_active:
        raise CodeWikiRunError(
            "RUNNER_INACTIVE: configured generation runner is inactive"
        )
    try:
        assert_user_can_read_source(db, runner.id, source)
    except SourceAccessDenied as exc:
        raise CodeWikiRunError(f"REPOSITORY_ACCESS_DENIED: {exc}") from exc

    from app.services.adapters.team_kinds import team_kinds_service

    team = team_kinds_service.get_team_by_name_and_namespace(
        db=db,
        team_name=wiki_settings.CODE_WIKI_TEAM_NAME,
        team_namespace="default",
        user_id=runner.id,
    )
    if not team:
        raise CodeWikiRunError(
            "MODEL_UNAVAILABLE: Code Wiki team is unavailable for this runner"
        )
    return runner


def configure_scheduled_update(
    db: Session, *, knowledge_base: Kind, data: CodeWikiAutomaticUpdateRequest
) -> Kind:
    """Create or update one scheduler row while serializing on its Code Wiki."""
    knowledge_base = (
        db.query(Kind)
        .filter(Kind.id == knowledge_base.id, Kind.is_active)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if knowledge_base is None:
        raise CodeWikiRunError("Code Wiki no longer exists")

    runner_id = data.execution_principal_user_id or knowledge_base.user_id
    if data.enabled:
        validate_runner(db, knowledge_base, runner_id)
    subscription = scheduled_update_for(db, knowledge_base)
    previous_internal = (
        dict((subscription.json or {}).get("_internal", {})) if subscription else {}
    )
    scheduled_at = first_scheduled_time(data)
    schedule = {
        "cadence": data.cadence,
        "interval_days": data.interval_days,
        "weekday": data.weekday,
        "hour": data.hour,
        "minute": data.minute,
        "timezone": data.timezone,
    }
    json_value = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Subscription",
        "metadata": {
            "name": f"code-wiki-{knowledge_base.id}",
            "namespace": knowledge_base.namespace,
        },
        "spec": {
            "displayName": knowledge_base.name,
            "taskType": "execution",
            "visibility": "private",
            "trigger": {
                "type": "interval",
                "interval": {"value": data.interval_days, "unit": "days"},
            },
            "teamRef": {
                "name": wiki_settings.CODE_WIKI_TEAM_NAME,
                "namespace": "default",
            },
            "promptTemplate": "Check and update Code Wiki",
            "retryCount": 0,
            "timeoutSeconds": SCHEDULED_UPDATE_TIMEOUT_SECONDS,
            "enabled": data.enabled,
            "executionTarget": {"type": "managed"},
            CODE_WIKI_REF_KEY: {"id": knowledge_base.id},
        },
        "status": {},
        "_internal": {
            "enabled": data.enabled,
            "trigger_type": "interval",
            "next_execution_time": scheduled_at.isoformat() if data.enabled else None,
            "last_execution_time": previous_internal.get("last_execution_time"),
            "last_execution_status": previous_internal.get("last_execution_status", ""),
            "execution_count": previous_internal.get("execution_count", 0),
            "success_count": previous_internal.get("success_count", 0),
            "failure_count": previous_internal.get("failure_count", 0),
            "bound_task_id": 0,
            "schedule": schedule,
        },
    }
    if subscription is None:
        subscription = Kind(
            user_id=knowledge_base.user_id,
            kind="Subscription",
            name=f"code-wiki-{knowledge_base.id}",
            namespace=knowledge_base.namespace,
            json=json_value,
            is_active=True,
        )
        db.add(subscription)
        db.flush()
    else:
        subscription.json = json_value
        flag_modified(subscription, "json")

    kb_json = dict(knowledge_base.json or {})
    spec = dict(kb_json.get("spec") or {})
    spec[SUBSCRIPTION_SPEC_KEY] = subscription.id
    if data.execution_principal_user_id is None:
        spec.pop(RUNNER_SPEC_KEY, None)
    else:
        spec[RUNNER_SPEC_KEY] = data.execution_principal_user_id
    kb_json["spec"] = spec
    knowledge_base.json = kb_json
    flag_modified(knowledge_base, "json")
    db.commit()
    db.refresh(subscription)
    return subscription


def read_scheduled_update(
    db: Session, *, knowledge_base: Kind, can_configure: bool
) -> CodeWikiAutomaticUpdate:
    subscription = scheduled_update_for(db, knowledge_base)
    runner_id = (knowledge_base.json or {}).get("spec", {}).get(RUNNER_SPEC_KEY)
    if subscription is None:
        return CodeWikiAutomaticUpdate(
            can_configure=can_configure,
            execution_principal_user_id=runner_id,
        )
    internal = (subscription.json or {}).get("_internal", {})
    schedule = internal.get("schedule") or {}
    rows = (
        db.query(BackgroundExecution)
        .filter(BackgroundExecution.subscription_id == subscription.id)
        .order_by(BackgroundExecution.created_at.desc())
        .limit(20)
        .all()
    )
    return CodeWikiAutomaticUpdate(
        can_configure=can_configure,
        configured=True,
        enabled=bool(internal.get("enabled", False)),
        next_execution_time=internal.get("next_execution_time"),
        execution_principal_user_id=runner_id,
        executions=[
            CodeWikiAutomaticUpdateExecution(
                id=row.id,
                status=row.status,
                error_message=row.error_message,
                result_summary=row.result_summary,
                task_id=row.task_id,
                created_at=row.created_at,
            )
            for row in rows
        ],
        **schedule,
    )


def advance_scheduled_update(
    subscription: Kind, *, now: datetime | None = None
) -> None:
    """Advance from the stored slot, preserving cadence and avoiding catch-up."""
    internal = (subscription.json or {}).get("_internal", {})
    schedule = internal.get("schedule") or {}
    interval_days = int(schedule.get("interval_days", 7))
    local_tz = ZoneInfo(schedule.get("timezone", "UTC"))
    scheduled_utc = datetime.fromisoformat(internal["next_execution_time"]).replace(
        tzinfo=timezone.utc
    )
    scheduled_local = scheduled_utc.astimezone(local_tz)
    clock = now or datetime.now(timezone.utc)
    clock = (
        clock.replace(tzinfo=timezone.utc)
        if clock.tzinfo is None
        else clock.astimezone(timezone.utc)
    )
    while scheduled_local.astimezone(timezone.utc) <= clock:
        scheduled_local += timedelta(days=interval_days)
    internal["next_execution_time"] = (
        scheduled_local.astimezone(timezone.utc).replace(tzinfo=None).isoformat()
    )
    subscription.json["_internal"] = internal
    flag_modified(subscription, "json")


def execute_scheduled_update(
    db: Session, *, subscription_id: int, execution_id: int
) -> None:
    subscription = db.get(Kind, subscription_id)
    execution = db.get(BackgroundExecution, execution_id)
    if (
        subscription is None
        or execution is None
        or not is_code_wiki_scheduled_update(subscription)
    ):
        return
    manager = subscription_service.execution_manager
    manager.update_execution_status(
        db,
        execution_id=execution_id,
        status=BackgroundExecutionStatus.RUNNING,
        skip_notifications=True,
    )
    knowledge_base = db.get(Kind, code_wiki_id(subscription))
    if knowledge_base is None or not knowledge_base.is_active:
        manager.update_execution_status(
            db,
            execution_id=execution_id,
            status=BackgroundExecutionStatus.FAILED,
            error_message="Code Wiki no longer exists",
            skip_notifications=True,
        )
        return
    runner_id = (
        (knowledge_base.json or {})
        .get("spec", {})
        .get(RUNNER_SPEC_KEY, knowledge_base.user_id)
    )
    try:
        run_state = current_run_state(db, knowledge_base)
        if run_state.status == "running" and not run_state.is_stale:
            manager.update_execution_status(
                db,
                execution_id=execution_id,
                status=BackgroundExecutionStatus.COMPLETED_SILENT,
                result_summary="Skipped because another generation is running",
                skip_notifications=True,
            )
            return
        runner = validate_runner(db, knowledge_base, int(runner_id))
        result = start_run(
            db,
            knowledge_base=knowledge_base,
            user=runner,
            force_full=False,
            background_execution_id=execution_id,
            background_execution_timeout_seconds=int(
                (subscription.json or {})
                .get("spec", {})
                .get("timeoutSeconds", SCHEDULED_UPDATE_TIMEOUT_SECONDS)
            ),
        )
    except GenerationInFlight:
        manager.update_execution_status(
            db,
            execution_id=execution_id,
            status=BackgroundExecutionStatus.COMPLETED_SILENT,
            result_summary="Skipped because another generation is running",
            skip_notifications=True,
        )
        return
    except Exception as exc:
        manager.update_execution_status(
            db,
            execution_id=execution_id,
            status=BackgroundExecutionStatus.FAILED,
            error_message=str(exc),
            skip_notifications=True,
        )
        return
    if not result.started:
        manager.update_execution_status(
            db,
            execution_id=execution_id,
            status=BackgroundExecutionStatus.COMPLETED_SILENT,
            result_summary=result.reason,
            skip_notifications=True,
        )
        return
    execution = db.get(BackgroundExecution, execution_id)
    execution.task_id = result.task_id
    execution.result_summary = f"{result.mode} generation started"
    db.commit()
