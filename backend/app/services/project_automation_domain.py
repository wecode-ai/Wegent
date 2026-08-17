# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Shared domain rules for project automation configuration and execution."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent
from app.models.kind import Kind
from app.services.execution.team_readiness import (
    validate_team_execution_readiness,
)
from app.services.loop_item_executions.profile import (
    validate_wework_execution_target,
)
from app.services.share import team_share_service

ASSIGNMENT_MODES = {"manual", "ai_managed"}
MANAGER_TYPES = {"custom", "wegent"}
TERMINAL_RUN_STATUSES = {"succeeded", "failed", "cancelled", "skipped"}


@dataclass(frozen=True)
class ProjectAutomationEvent:
    event_type: str
    project_id: str
    subject_id: str
    source: str
    actor_user_id: int | None
    payload: dict


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def utc_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def metadata(row: object) -> dict:
    value = getattr(row, "metadata_json", None)
    return dict(value) if isinstance(value, dict) else {}


def next_run(expression: str, timezone_name: str, after: datetime) -> datetime:
    try:
        tz = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown timezone"
        ) from exc
    if not croniter.is_valid(expression):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid cron expression"
        )
    aware = after.replace(tzinfo=timezone.utc).astimezone(tz)
    result = croniter(expression, aware).get_next(datetime)
    return result.astimezone(timezone.utc).replace(tzinfo=None)


def integer(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def text(value: object) -> str | None:
    return str(value) if isinstance(value, str) and value else None


def assignment_mode(value: dict) -> str:
    configured = value.get("assignment_mode")
    if configured in ASSIGNMENT_MODES:
        return str(configured)
    raise ValueError("Automation assignment mode is missing or invalid")


def manager_type(value: dict) -> str | None:
    configured = value.get("manager_type")
    if configured is None:
        return None
    if configured not in MANAGER_TYPES:
        raise ValueError("Automation manager type is invalid")
    return str(configured)


def project_agent(
    db: Session, project_id: str, agent_id: str | None
) -> ProjectChatAgent:
    agent = db.get(ProjectChatAgent, agent_id) if agent_id else None
    if (
        agent is None
        or str(agent.cloud_project_id) != str(project_id)
        or agent.status != "active"
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Robot is not active")
    return agent


def wegent_team(db: Session, user_id: int, team_id: int | None) -> Kind:
    team = (
        team_share_service.get_resource(db, team_id, user_id)
        if team_id is not None
        else None
    )
    if team is None or team.kind != "Team" or not team.is_active:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Wegent Team is not accessible or active",
        )
    return team


def runnable_wegent_team(db: Session, user_id: int, team_id: int | None) -> Kind:
    """Resolve an accessible Team and prove its execution dependencies exist."""

    team = wegent_team(db, user_id, team_id)
    try:
        validate_team_execution_readiness(
            db,
            team=team,
            execution_user_id=user_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Wegent Team is not runnable: {exc}",
        ) from exc
    return team


def validate_assignment(
    db: Session,
    *,
    project_id: str,
    user_id: int,
    mode: str,
    manager: str | None,
    agent_id: str | None,
    wegent_team_id: int | None,
    model: str | None,
    environment: str | None,
    device_id: str | None,
) -> None:
    if mode == "manual":
        if not agent_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "agent_id is required for manual assignment",
            )
        project_agent(db, project_id, agent_id)
        return
    if mode != "ai_managed":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown assignment mode"
        )
    if manager == "custom":
        if not model or not environment or not device_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Custom AI manager configuration is incomplete",
            )
        validate_wework_execution_target(
            db,
            user_id=user_id,
            environment=environment,
            execution_device_id=device_id,
        )
        return
    if manager == "wegent":
        runnable_wegent_team(db, user_id, wegent_team_id)
        return
    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown AI manager type")


def validate_trigger(
    trigger_type: str, event_type: str | None, cron_expression: str | None
) -> None:
    if trigger_type == "schedule":
        if not cron_expression:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "cron_expression is required for schedule trigger",
            )
        next_run(str(cron_expression), "UTC", utcnow())
        return
    if trigger_type == "event" and event_type == "task.created":
        return
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY, "Unsupported automation trigger"
    )
