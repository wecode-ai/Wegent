# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused endpoint tests for project automation run control."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.api.endpoints import project_automations
from app.models.delivery import ProjectAutomationRun
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.project_automation import ProjectAutomationRunView


def _run_view(run: ProjectAutomationRun) -> ProjectAutomationRunView:
    now = datetime.now(UTC)
    return ProjectAutomationRunView(
        id=run.id,
        automation_id="rule-1",
        project_id="project-1",
        trigger="manual",
        status="cancelled",
        timezone="Asia/Shanghai",
        scheduled_for=now,
        expires_at=None,
        task_id=run.task_id,
        backend_task_id=run.backend_task_id,
        device_id=None,
        error=None,
        created_at=now,
        updated_at=now,
        completed_at=run.completed_at,
    )


@pytest.mark.asyncio
async def test_cancel_run_delegates_to_the_single_cancellation_service(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = ProjectAutomationRun(
        id="automation-run-1",
        task_id="board-task-1",
        title="Automation run",
        description="",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(run)
    test_db.commit()

    cancel = AsyncMock(return_value=_run_view(run))
    monkeypatch.setattr(
        project_automations.project_automation_service, "cancel_run", cancel
    )
    result = await project_automations.cancel_run(
        project_id="project-1",
        run_id=run.id,
        db=test_db,
        current_user=test_user,
    )

    assert result.status == "cancelled"
    cancel.assert_awaited_once_with(test_db, "project-1", run.id, test_user.id)


@pytest.mark.asyncio
async def test_cancel_managed_wegent_run_never_emits_wework_runtime_cancel(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task = TaskResource(
        id=12345,
        user_id=test_user.id,
        kind="Task",
        name="managed-automation-task",
        namespace="default",
        json={},
    )
    run = ProjectAutomationRun(
        id="managed-run-1",
        task_id="board-task-1",
        backend_task_id=12345,
        title="Managed automation run",
        description="",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add_all([task, run])
    test_db.commit()

    cancel = AsyncMock(return_value=_run_view(run))
    monkeypatch.setattr(
        project_automations.project_automation_service, "cancel_run", cancel
    )
    result = await project_automations.cancel_run(
        project_id="project-1",
        run_id=run.id,
        db=test_db,
        current_user=test_user,
    )

    assert result.backend_task_id == 12345
    cancel.assert_awaited_once_with(test_db, "project-1", run.id, test_user.id)


@pytest.mark.asyncio
async def test_retry_run_delegates_to_the_automation_service(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = ProjectAutomationRun(
        id="failed-run-1",
        task_id="board-task-1",
        title="Failed automation run",
        description="manager failed",
        status="failed",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(run)
    test_db.commit()

    retry = AsyncMock(return_value=_run_view(run))
    monkeypatch.setattr(
        project_automations.project_automation_service, "retry_run", retry
    )

    result = await project_automations.retry_run(
        project_id="project-1",
        run_id=run.id,
        db=test_db,
        current_user=test_user,
    )

    assert result.id == run.id
    retry.assert_awaited_once_with(test_db, "project-1", run.id, test_user.id)
