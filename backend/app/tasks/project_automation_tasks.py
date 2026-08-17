# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Periodic dispatch for Wework project automations."""

import asyncio
import logging

from app.core.celery_app import celery_app
from app.db.session import SessionLocal
from app.services.project_automations import project_automation_service

logger = logging.getLogger(__name__)


def check_due_project_automations_sync() -> int:
    db = SessionLocal()
    try:
        return asyncio.run(project_automation_service.check_due(db))
    except Exception:
        db.rollback()
        logger.exception("Project automation scheduler failed")
        return 0
    finally:
        db.close()


@celery_app.task(
    name="app.tasks.project_automation_tasks.check_due_project_automations"
)
def check_due_project_automations() -> int:
    return check_due_project_automations_sync()


@celery_app.task(
    name="app.tasks.project_automation_tasks.execute_managed_project_automation"
)
def execute_managed_project_automation(
    *,
    task_id: int,
    assistant_subtask_id: int,
    user_subtask_id: int,
    team_id: int,
    user_id: int,
    prompt: str,
) -> dict[str, int | str]:
    """Execute one persisted Wework automation Task in the Celery worker."""

    from app.services.project_automation_completion import (
        fail_project_automation_dispatch,
    )
    from app.services.project_automation_managed_execution import (
        ManagedTeamExecutionHandle,
        project_automation_managed_execution_service,
    )

    handle = ManagedTeamExecutionHandle(
        task_id=task_id,
        subtask_id=assistant_subtask_id,
    )
    try:
        dispatched = asyncio.run(
            project_automation_managed_execution_service.execute(
                handle=handle,
                user_subtask_id=user_subtask_id,
                team_id=team_id,
                user_id=user_id,
                prompt=prompt,
            )
        )
    except Exception as exc:
        error = str(exc) or "AI 托管任务派发失败。"
        logger.exception(
            "Managed project automation execution failed: task_id=%s", task_id
        )
        project_automation_managed_execution_service.mark_dispatch_failed(
            task_id=task_id,
            user_id=user_id,
            error=error,
        )
        fail_project_automation_dispatch(task_id=task_id, error=error)
        raise
    return {
        "status": "dispatched" if dispatched else "skipped",
        "task_id": task_id,
    }
