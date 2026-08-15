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
    name="app.tasks.project_automation_tasks.dispatch_board_robot_execution"
)
def dispatch_board_robot_execution(*, execution_id: int) -> bool:
    """Activate one exact Wegent-runtime board execution after commit."""

    from app.services.board_team_execution import (
        dispatch_board_robot_execution as dispatch_execution,
    )

    db = SessionLocal()
    try:
        execution = asyncio.run(dispatch_execution(db, execution_id=execution_id))
        return execution is not None
    except Exception as exc:
        db.rollback()
        logger.exception(
            "Board robot runtime activation failed: execution_id=%s",
            execution_id,
        )
        from app.services.loop_item_executions.service import (
            loop_item_execution_service,
        )

        loop_item_execution_service.fail(
            db,
            execution_id=execution_id,
            error=str(exc) or "Wegent runtime activation failed",
            termination_reason="wegent_runtime_activation_failed",
        )
        raise
    finally:
        db.close()


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
    source: str = "project_automation",
    execution_id: int = 0,
) -> dict[str, int | str]:
    """Execute one persisted managed Team Task in the Celery worker."""

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
        source=source,
        execution_id=execution_id,
    )
    try:
        execute_kwargs = {
            "handle": handle,
            "user_subtask_id": user_subtask_id,
            "team_id": team_id,
            "user_id": user_id,
            "prompt": prompt,
        }
        if source != "project_automation":
            execute_kwargs.update(
                {
                    "source": source,
                    "execution_id": execution_id,
                }
            )
        dispatched = asyncio.run(
            project_automation_managed_execution_service.execute(**execute_kwargs)
        )
    except Exception as exc:
        error = str(exc) or "AI 托管任务派发失败。"
        logger.exception(
            "Managed project automation execution failed: task_id=%s", task_id
        )
        if source == "board_team_assignment":
            from app.db.session import SessionLocal
            from app.services.loop_item_executions.service import (
                loop_item_execution_service,
            )

            db = SessionLocal()
            try:
                project_automation_managed_execution_service.mark_dispatch_failed(
                    task_id=task_id,
                    user_id=user_id,
                    error=error,
                )
                loop_item_execution_service.fail(
                    db,
                    execution_id=execution_id,
                    error=error,
                    termination_reason="managed_team_dispatch_failed",
                )
            finally:
                db.close()
        else:
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


@celery_app.task(
    name="app.tasks.project_automation_tasks.execute_board_team_continuation"
)
def execute_board_team_continuation(
    *,
    task_id: int,
    assistant_subtask_id: int,
    user_subtask_id: int,
    team_id: int,
    user_id: int,
    prompt: str,
) -> dict[str, int | str]:
    """Execute one persisted follow-up turn in a board Bot's native Task."""

    from app.services.board_team_continuation import (
        CONTINUATION_SOURCE,
        fail_board_team_continuation,
    )
    from app.services.project_automation_managed_execution import (
        ManagedTeamExecutionHandle,
        project_automation_managed_execution_service,
    )

    handle = ManagedTeamExecutionHandle(
        task_id=task_id,
        subtask_id=assistant_subtask_id,
        source=CONTINUATION_SOURCE,
    )
    try:
        dispatched = asyncio.run(
            project_automation_managed_execution_service.execute(
                handle=handle,
                user_subtask_id=user_subtask_id,
                team_id=team_id,
                user_id=user_id,
                prompt=prompt,
                source=CONTINUATION_SOURCE,
            )
        )
    except Exception as exc:
        error = str(exc) or "Wegent continuation dispatch failed"
        logger.exception("Board Team continuation failed: task_id=%s", task_id)
        fail_board_team_continuation(
            task_id=task_id,
            subtask_id=assistant_subtask_id,
            user_id=user_id,
            error=error,
        )
        raise
    return {
        "status": "dispatched" if dispatched else "skipped",
        "task_id": task_id,
    }


@celery_app.task(
    name="app.tasks.project_automation_tasks.cancel_managed_board_team_execution"
)
def cancel_managed_board_team_execution(*, task_id: int, user_id: int) -> bool:
    """Cancel the native Wegent Task behind one board Team execution."""

    from app.services.project_automation_managed_execution import (
        project_automation_managed_execution_service,
    )

    return asyncio.run(
        project_automation_managed_execution_service.cancel(
            task_id=task_id,
            user_id=user_id,
            source="board_team_assignment",
        )
    )
