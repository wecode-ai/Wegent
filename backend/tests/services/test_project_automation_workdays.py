# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cloud project schedules use the same offline calendar as device schedules."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
)
from app.models.user import User
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationUpdate,
)
from app.services import project_automation_execution as execution_module
from app.services import project_automations as service_module
from app.services.project_automation_domain import next_run
from app.services.project_automation_execution import project_automation_execution
from app.services.project_automations import project_automation_service
from shared.utils import workday as workday_calendar
from tests.utils.collaboration import authorize_project


@pytest.fixture
def calendar_project(test_db: Session, test_user: User) -> CloudProject:
    project = CloudProject(
        project_key="WORKDAYS",
        name="Workday automation project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/workday-test",
    )
    authorize_project(test_db, project)
    test_db.commit()
    test_db.refresh(project)
    return project


def schedule_input(user_id: int, workday_only: bool = True) -> ProjectAutomationCreate:
    return ProjectAutomationCreate(
        name="Daily report",
        prompt="Summarize the workday",
        cron_expression="0 9 * * *",
        timezone="Asia/Shanghai",
        workday_only=workday_only,
        target_kind="human",
        target_id=str(user_id),
    )


@pytest.mark.parametrize(
    "after,expected",
    [
        (datetime(2026, 9, 30, 2), datetime(2026, 10, 8, 1)),
        (datetime(2026, 10, 9, 2), datetime(2026, 10, 10, 1)),
        (datetime(2026, 10, 10, 2), datetime(2026, 10, 12, 1)),
    ],
)
def test_cloud_next_run_uses_statutory_days(
    after: datetime, expected: datetime
) -> None:
    assert next_run("0 9 * * *", "Asia/Shanghai", after, True) == expected


def test_cloud_workday_errors_are_explicit_and_flags_are_strict() -> None:
    with pytest.raises(HTTPException, match="does not cover") as error:
        next_run("0 9 * * *", "UTC", datetime(2100, 1, 1), True)
    assert error.value.status_code == 422
    with pytest.raises(ValidationError):
        ProjectAutomationCreate.model_validate(
            {**schedule_input(1).model_dump(), "workday_only": "false"}
        )


def test_unavailable_calendar_does_not_prevent_saving_disabled_rule(
    test_db: Session,
    test_user: User,
    calendar_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service_module, "utcnow", lambda: datetime(2100, 1, 1))
    values = schedule_input(test_user.id).model_copy(update={"enabled": False})
    created = project_automation_service.create(
        test_db, str(calendar_project.id), test_user.id, values
    )
    assert created["workday_only"] is True
    assert created["enabled"] is False
    assert created["next_run_at"] is None


def test_workday_filter_round_trips_and_can_be_disabled(
    test_db: Session,
    test_user: User,
    calendar_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service_module, "utcnow", lambda: datetime(2026, 9, 30, 2))
    created = project_automation_service.create(
        test_db, str(calendar_project.id), test_user.id, schedule_input(test_user.id)
    )
    assert created["workday_only"] is True
    assert created["next_run_at"].replace(tzinfo=None) == datetime(2026, 10, 8, 1)
    renamed = project_automation_service.update(
        test_db,
        str(calendar_project.id),
        str(created["id"]),
        test_user.id,
        ProjectAutomationUpdate(version=created["version"], name="Renamed report"),
    )
    assert renamed["workday_only"] is True
    disabled = project_automation_service.update(
        test_db,
        str(calendar_project.id),
        str(created["id"]),
        test_user.id,
        ProjectAutomationUpdate(version=renamed["version"], workday_only=False),
    )
    assert disabled["workday_only"] is False
    assert disabled["next_run_at"].replace(tzinfo=None) == datetime(2026, 10, 1, 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("workday,expected_runs", [(False, 0), (True, 1)])
async def test_due_scan_filters_actual_dispatch_day(
    test_db: Session,
    test_user: User,
    calendar_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
    workday: bool,
    expected_runs: int,
) -> None:
    monkeypatch.setattr(service_module, "utcnow", lambda: datetime(2026, 9, 30, 2))
    created = project_automation_service.create(
        test_db, str(calendar_project.id), test_user.id, schedule_input(test_user.id)
    )
    rule = test_db.get(ProjectAutomationRule, created["id"])
    rule.due_at = datetime(2026, 9, 30, 1)
    test_db.commit()
    now = datetime(2026, 10, 10 if workday else 1, 1)
    monkeypatch.setattr(service_module, "utcnow", lambda: now)
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    assert await project_automation_service.check_due(test_db) == expected_runs
    assert dispatch.await_count == expected_runs
    runs = test_db.query(ProjectAutomationRun).all()
    assert len(runs) == expected_runs
    if runs:
        assert runs[0].metadata_json["workday_only"] is True
    test_db.refresh(rule)
    assert rule.due_at > now


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "trigger,workday_only,skipped",
    [("scheduled", True, True), ("manual", True, False), ("scheduled", False, False)],
)
async def test_delayed_cloud_dispatch_checks_persisted_run(
    test_db: Session,
    test_user: User,
    calendar_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
    trigger: str,
    workday_only: bool,
    skipped: bool,
) -> None:
    monkeypatch.setattr(service_module, "utcnow", lambda: datetime(2026, 9, 30, 2))
    created = project_automation_service.create(
        test_db,
        str(calendar_project.id),
        test_user.id,
        schedule_input(test_user.id, workday_only),
    )
    rule = test_db.get(ProjectAutomationRule, created["id"])
    run = project_automation_service._create_run(
        test_db, rule, trigger, datetime(2026, 9, 30, 1)
    )
    monkeypatch.setattr(execution_module, "utcnow", lambda: datetime(2026, 10, 1, 1))
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", MagicMock())
    create_task = MagicMock(wraps=project_automation_execution._ensure_run_task)
    monkeypatch.setattr(project_automation_execution, "_ensure_run_task", create_task)
    await project_automation_execution.dispatch(test_db, rule, run)
    assert create_task.called is (not skipped)
    test_db.refresh(run)
    tasks = test_db.query(LoopItem).all()
    assert len(tasks) == (0 if skipped else 1)
    if skipped:
        assert run.status == "skipped"
        assert "not a China statutory workday" in run.description
        assert not run.task_id
    else:
        assert run.status == "succeeded"
        assert run.task_id == tasks[0].id
        assert tasks[0].assignee_user_id == test_user.id


@pytest.mark.asyncio
async def test_calendar_fault_defers_one_rule_and_recovers_without_reenable(
    test_db: Session,
    test_user: User,
    calendar_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service_module, "utcnow", lambda: datetime(2026, 9, 30, 2))
    rows = []
    for workday_only in [True, False]:
        created = project_automation_service.create(
            test_db,
            str(calendar_project.id),
            test_user.id,
            schedule_input(test_user.id, workday_only),
        )
        row = test_db.get(ProjectAutomationRule, created["id"])
        row.due_at = datetime(2026, 9, 30, 1)
        rows.append(row)
    test_db.commit()
    monkeypatch.setattr(service_module, "utcnow", lambda: datetime(2026, 10, 10, 1))
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    original = workday_calendar.is_workday

    def unavailable(*_args: object) -> bool:
        raise workday_calendar.WorkdayCalendarError("Calendar data is unavailable")

    monkeypatch.setattr(workday_calendar, "is_workday", unavailable)
    assert await project_automation_service.check_due(test_db) == 1
    filtered = rows[0]
    test_db.refresh(filtered)
    assert filtered.status == "enabled"
    assert filtered.due_at == datetime(2026, 9, 30, 1)
    assert filtered.metadata_json["schedule_error"] == "Calendar data is unavailable"
    monkeypatch.setattr(workday_calendar, "is_workday", original)
    assert await project_automation_service.check_due(test_db) == 1
    test_db.refresh(filtered)
    assert filtered.status == "enabled"
    assert "schedule_error" not in filtered.metadata_json
    assert dispatch.await_count == 2
