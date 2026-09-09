# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project Code Wiki automatic updates onto the generic scheduler."""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.wiki_config import wiki_settings
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.user import User
from app.schemas.knowledge import CodeWikiAutomaticUpdateRequest
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
from app.services.subscription import subscription_service

RUNNER_SPEC_KEY = "executionPrincipalUserId"
INTERNAL_WIKI_KEY = "code_wiki_id"


def plan_for(db: Session, knowledge_base_id: int) -> Kind | None:
    plans = (
        db.query(Kind)
        .filter(
            Kind.kind == "Subscription",
            Kind.name == f"code-wiki-{knowledge_base_id}",
            Kind.is_active == True,
        )
        .all()
    )
    return next(
        (
            plan
            for plan in plans
            if (plan.json or {}).get("_internal", {}).get(INTERNAL_WIKI_KEY)
            == knowledge_base_id
        ),
        None,
    )


def is_code_wiki_plan(subscription: Kind) -> bool:
    return bool((subscription.json or {}).get("_internal", {}).get(INTERNAL_WIKI_KEY))


def next_time(
    data: CodeWikiAutomaticUpdateRequest, now: datetime | None = None
) -> datetime:
    """Return the next future wall-clock occurrence as naive UTC."""
    try:
        local_tz = ZoneInfo(data.timezone)
    except Exception as exc:
        raise ValueError(f"Invalid IANA timezone: {data.timezone}") from exc
    current = (now or datetime.now(timezone.utc)).astimezone(local_tz)
    candidate = current.replace(
        hour=data.hour, minute=data.minute, second=0, microsecond=0
    )
    candidate += timedelta(days=(data.weekday - current.weekday()) % 7)
    if candidate <= current:
        candidate += timedelta(days=data.interval_days)
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


def configure_plan(
    db: Session, *, knowledge_base: Kind, data: CodeWikiAutomaticUpdateRequest
) -> Kind:
    runner_id = data.execution_principal_user_id or knowledge_base.user_id
    validate_runner(db, knowledge_base, runner_id)
    plan = plan_for(db, knowledge_base.id)
    previous_internal = dict((plan.json or {}).get("_internal", {})) if plan else {}
    scheduled_at = next_time(data)
    schedule = {
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
            "timeoutSeconds": 86400,
            "enabled": data.enabled,
            "executionTarget": {"type": "managed"},
            "codeWikiRef": {"id": knowledge_base.id},
        },
        "status": {},
        "_internal": {
            INTERNAL_WIKI_KEY: knowledge_base.id,
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
    if plan is None:
        plan = Kind(
            user_id=knowledge_base.user_id,
            kind="Subscription",
            name=f"code-wiki-{knowledge_base.id}",
            namespace=knowledge_base.namespace,
            json=json_value,
            is_active=True,
        )
        db.add(plan)
    else:
        plan.json = json_value
        flag_modified(plan, "json")

    kb_json = dict(knowledge_base.json or {})
    spec = dict(kb_json.get("spec") or {})
    if data.execution_principal_user_id is None:
        spec.pop(RUNNER_SPEC_KEY, None)
    else:
        spec[RUNNER_SPEC_KEY] = data.execution_principal_user_id
    kb_json["spec"] = spec
    knowledge_base.json = kb_json
    flag_modified(knowledge_base, "json")
    db.commit()
    db.refresh(plan)
    return plan


def advance_plan(subscription: Kind, *, now: datetime | None = None) -> None:
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


def execute_plan(db: Session, *, subscription_id: int, execution_id: int) -> None:
    plan = db.get(Kind, subscription_id)
    execution = db.get(BackgroundExecution, execution_id)
    if plan is None or execution is None or not is_code_wiki_plan(plan):
        return
    manager = subscription_service.execution_manager
    manager.update_execution_status(
        db,
        execution_id=execution_id,
        status=BackgroundExecutionStatus.RUNNING,
        skip_notifications=True,
    )
    knowledge_base = db.get(Kind, plan.json["_internal"][INTERNAL_WIKI_KEY])
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
            db, knowledge_base=knowledge_base, user=runner, force_full=False
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
