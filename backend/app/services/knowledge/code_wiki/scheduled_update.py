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
    CodeWikiScheduledUpdate,
    CodeWikiScheduledUpdateExecution,
    CodeWikiScheduledUpdateRequest,
)
from app.schemas.subscription import BackgroundExecutionStatus
from app.services.knowledge.code_wiki.generation import (
    GenerationInFlight,
    current_run_state,
)
from app.services.knowledge.code_wiki.generation_strategy import (
    GENERATION_STRATEGY_SPEC_KEY,
    strategy_for_run,
)
from app.services.knowledge.code_wiki.runner import (
    CodeWikiRunError,
    assert_runner_can_execute_in_namespace,
    source_of,
    start_run,
    strategy_team_readiness_many,
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
    spec = (subscription.json or {}).get("spec")
    if not isinstance(spec, dict):
        return None
    code_wiki_ref = spec.get(CODE_WIKI_REF_KEY)
    if not isinstance(code_wiki_ref, dict):
        return None
    value = code_wiki_ref.get("id")
    return value if isinstance(value, int) and value > 0 else None


def _references_code_wiki(subscription: Kind, knowledge_base: Kind) -> bool:
    """Match the complete persisted Kind identity."""
    if code_wiki_id(subscription) != knowledge_base.id:
        return False
    code_wiki_ref = (subscription.json or {}).get("spec", {}).get(CODE_WIKI_REF_KEY)
    expected = {
        "id": knowledge_base.id,
        "name": knowledge_base.name,
        "namespace": knowledge_base.namespace,
        "userId": knowledge_base.user_id,
    }
    return all(code_wiki_ref.get(key) == value for key, value in expected.items())


def is_code_wiki_scheduled_update(subscription: Kind) -> bool:
    return code_wiki_id(subscription) is not None


def reject_code_wiki_scheduled_update(subscription: Kind, *, detail: str) -> None:
    """Keep internal scheduler rows behind the Code Wiki management boundary."""
    if is_code_wiki_scheduled_update(subscription):
        raise HTTPException(status_code=409, detail=detail)


def scheduled_update_for(db: Session, knowledge_base: Kind) -> Kind | None:
    """Resolve a plan only through the authoritative id stored on the Code Wiki."""
    subscription_id = (
        (knowledge_base.json or {}).get("spec", {}).get(SUBSCRIPTION_SPEC_KEY)
    )
    if not isinstance(subscription_id, int) or subscription_id <= 0:
        return None
    subscription = db.get(Kind, subscription_id)
    if (
        subscription is None
        or not subscription.is_active
        or not _references_code_wiki(subscription, knowledge_base)
    ):
        return None
    return subscription


def first_scheduled_time(
    data: CodeWikiScheduledUpdateRequest,
    now: datetime | None = None,
    *,
    defer_first_execution: bool = False,
) -> datetime:
    """Return the first matching future slot as naive UTC.

    Creation may defer to tomorrow because it already starts the first full
    generation immediately. Editing or re-enabling a plan instead uses a later slot
    today when one remains, which keeps a changed schedule intuitive to test.
    """
    try:
        local_tz = ZoneInfo(data.timezone)
    except Exception as exc:
        raise ValueError(f"Invalid IANA timezone: {data.timezone}") from exc
    current = (now or datetime.now(timezone.utc)).astimezone(local_tz)
    first_date = (
        current.date() + timedelta(days=1) if defer_first_execution else current.date()
    )
    candidate = datetime.combine(
        first_date, datetime.min.time(), tzinfo=local_tz
    ).replace(hour=data.hour, minute=data.minute)
    if data.cadence in {"weekly", "biweekly", "four_weeks"}:
        candidate += timedelta(days=(data.weekday - candidate.weekday()) % 7)
        if candidate <= current:
            candidate += timedelta(days=7)
    elif candidate <= current:
        candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc).replace(tzinfo=None)


def _is_local_creation_day(
    knowledge_base: Kind, timezone_name: str, now: datetime
) -> bool:
    created_at = knowledge_base.created_at
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    try:
        local_timezone = ZoneInfo(timezone_name)
    except Exception as exc:
        raise ValueError(f"Invalid IANA timezone: {timezone_name}") from exc
    return (
        created_at.astimezone(local_timezone).date()
        == now.astimezone(local_timezone).date()
    )


def validate_runner(db: Session, knowledge_base: Kind, user_id: int) -> User:
    runner = validate_runner_for_source(
        db, user_id=user_id, source=source_of(knowledge_base)
    )
    assert_runner_can_execute_in_namespace(db, knowledge_base, runner)
    stored_strategy_id = ((knowledge_base.json or {}).get("spec") or {}).get(
        GENERATION_STRATEGY_SPEC_KEY
    )
    try:
        legacy_strategy = strategy_for_run(None, db=db)
        stored_strategy = strategy_for_run(stored_strategy_id, db=db)
    except ValueError as exc:
        raise CodeWikiRunError(str(exc)) from exc
    strategies = [legacy_strategy]
    if stored_strategy.strategy_id != legacy_strategy.strategy_id:
        strategies.append(stored_strategy)
    for readiness in strategy_team_readiness_many(db, runner, strategies).values():
        if readiness:
            raise CodeWikiRunError(f"MODEL_UNAVAILABLE: {readiness}")
    return runner


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

    return runner


def configure_scheduled_update(
    db: Session, *, knowledge_base: Kind, data: CodeWikiScheduledUpdateRequest
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
    knowledge_base_spec = (knowledge_base.json or {}).get("spec") or {}
    if knowledge_base_spec.get("kbType") != "code_wiki":
        raise CodeWikiRunError("Knowledge base is not a Code Wiki")

    runner_id = data.execution_principal_user_id or knowledge_base.user_id
    if data.enabled:
        validate_runner(db, knowledge_base, runner_id)
    subscription = scheduled_update_for(db, knowledge_base)
    previous_internal = (
        dict((subscription.json or {}).get("_internal", {})) if subscription else {}
    )
    now = datetime.now(timezone.utc)
    scheduled_at = first_scheduled_time(
        data,
        now=now,
        defer_first_execution=(
            subscription is None
            and _is_local_creation_day(knowledge_base, data.timezone, now)
        ),
    )
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
            "displayName": str(knowledge_base_spec.get("name") or knowledge_base.name),
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
            CODE_WIKI_REF_KEY: {
                "id": knowledge_base.id,
                "name": knowledge_base.name,
                "namespace": knowledge_base.namespace,
                "userId": knowledge_base.user_id,
            },
        },
        "status": {},
        "_internal": {
            "enabled": data.enabled,
            "trigger_type": "interval",
            "next_execution_time": scheduled_at.isoformat() if data.enabled else None,
            "last_execution_time": previous_internal.get("last_execution_time"),
            "last_execution_status": previous_internal.get("last_execution_status", ""),
            "last_execution_message": previous_internal.get(
                "last_execution_message", ""
            ),
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


def delete_scheduled_update(db: Session, *, knowledge_base: Kind) -> None:
    """Archive one Code Wiki plan without deleting its execution history."""
    knowledge_base = (
        db.query(Kind)
        .filter(Kind.id == knowledge_base.id, Kind.is_active)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if knowledge_base is None:
        raise CodeWikiRunError("Code Wiki no longer exists")

    subscription = scheduled_update_for(db, knowledge_base)
    if subscription is not None:
        subscription = (
            db.query(Kind)
            .filter(Kind.id == subscription.id, Kind.is_active)
            .with_for_update()
            .first()
        )
        if subscription is not None:
            subscription.is_active = False
            internal = dict((subscription.json or {}).get("_internal", {}))
            internal["enabled"] = False
            subscription.json["_internal"] = internal
            flag_modified(subscription, "json")

    # Clear the authoritative KB link even when an earlier partial operation has
    # already made its plan inactive. Otherwise this idempotent delete would leave
    # a dangling projection id that no longer resolves to a configurable plan.
    kb_json = dict(knowledge_base.json or {})
    spec = dict(kb_json.get("spec") or {})
    spec.pop(SUBSCRIPTION_SPEC_KEY, None)
    spec.pop(RUNNER_SPEC_KEY, None)
    kb_json["spec"] = spec
    knowledge_base.json = kb_json
    flag_modified(knowledge_base, "json")
    db.commit()


def retarget_scheduled_update(
    db: Session,
    *,
    knowledge_base: Kind,
    name: str,
    namespace: str,
    user_id: int | None = None,
) -> None:
    """Keep an internal plan attached when its Code Wiki Kind identity changes."""
    subscription = scheduled_update_for(db, knowledge_base)
    if subscription is None:
        return
    subscription = (
        db.query(Kind)
        .filter(Kind.id == subscription.id, Kind.is_active)
        .populate_existing()
        .with_for_update()
        .one()
    )
    target_user_id = user_id if user_id is not None else knowledge_base.user_id
    subscription.namespace = namespace
    subscription.user_id = target_user_id
    subscription_json = dict(subscription.json or {})
    metadata = dict(subscription_json.get("metadata") or {})
    metadata["namespace"] = namespace
    subscription_json["metadata"] = metadata
    spec = dict(subscription_json.get("spec") or {})
    spec[CODE_WIKI_REF_KEY] = {
        "id": knowledge_base.id,
        "name": name,
        "namespace": namespace,
        "userId": target_user_id,
    }
    subscription_json["spec"] = spec
    subscription.json = subscription_json
    flag_modified(subscription, "json")


def read_scheduled_update(
    db: Session, *, knowledge_base: Kind, can_configure: bool
) -> CodeWikiScheduledUpdate:
    subscription = scheduled_update_for(db, knowledge_base)
    runner_id = (knowledge_base.json or {}).get("spec", {}).get(RUNNER_SPEC_KEY)
    if subscription is None:
        return CodeWikiScheduledUpdate(
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
    return CodeWikiScheduledUpdate(
        can_configure=can_configure,
        configured=True,
        enabled=bool(internal.get("enabled", False)),
        next_execution_time=internal.get("next_execution_time"),
        execution_principal_user_id=runner_id,
        executions=[
            CodeWikiScheduledUpdateExecution(
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
    snapshot = db.get(Kind, subscription_id)
    knowledge_base_id = code_wiki_id(snapshot) if snapshot is not None else None
    if knowledge_base_id is None:
        return
    execution = db.get(BackgroundExecution, execution_id)
    if execution is None or not is_code_wiki_scheduled_update(snapshot):
        return
    manager = subscription_service.execution_manager
    manager.update_execution_status(
        db,
        execution_id=execution_id,
        status=BackgroundExecutionStatus.RUNNING,
        skip_notifications=True,
    )
    # update_execution_status commits. Re-acquire lifecycle locks after it, in the
    # same KB -> plan order used by configuration and deletion, before admitting a
    # generation.
    knowledge_base = (
        db.query(Kind)
        .filter(Kind.id == knowledge_base_id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    subscription = (
        db.query(Kind)
        .filter(Kind.id == subscription_id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if subscription is None or not is_code_wiki_scheduled_update(subscription):
        return
    # A worker may have been enqueued just before its plan was deleted. Preserve the
    # execution record but make that queued attempt terminal instead of starting a
    # run after the user explicitly removed future updates.
    if not subscription.is_active:
        manager.update_execution_status(
            db,
            execution_id=execution_id,
            status=BackgroundExecutionStatus.COMPLETED_SILENT,
            result_summary="Skipped because scheduled update was deleted",
            skip_notifications=True,
        )
        return
    if not bool((subscription.json or {}).get("_internal", {}).get("enabled", False)):
        manager.update_execution_status(
            db,
            execution_id=execution_id,
            status=BackgroundExecutionStatus.COMPLETED_SILENT,
            result_summary="Skipped because scheduled update was disabled",
            skip_notifications=True,
        )
        return
    if (
        knowledge_base is None
        or not knowledge_base.is_active
        or not _references_code_wiki(subscription, knowledge_base)
    ):
        manager.update_execution_status(
            db,
            execution_id=execution_id,
            status=BackgroundExecutionStatus.FAILED,
            error_message="Code Wiki no longer exists or its reference no longer matches",
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
