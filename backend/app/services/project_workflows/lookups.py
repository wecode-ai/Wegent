# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Shared workflow lookup, authorization-boundary, and state helpers."""

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent, loop_datetime_is_unset
from app.models.project_workflow import (
    ProjectAgentSquad,
    ProjectRepositoryBinding,
    ProjectWorkflowDefinition,
    TaskExecutionBinding,
    TaskStageRun,
    TaskWorkflowRun,
)


class WorkflowLookupMixin:
    """Shared workflow lookup, authorization-boundary, and state helpers."""

    @staticmethod
    def _workflow_group(
        run: TaskWorkflowRun,
        group_key: str,
    ) -> dict[str, Any]:
        for group in run.workflow_definition_snapshot.get("stages") or []:
            if group.get("key") == group_key:
                return group
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Workflow snapshot no longer contains the running group",
        )

    @staticmethod
    def _task_binding(db: Session, item_id: str) -> TaskExecutionBinding:
        binding = (
            db.query(TaskExecutionBinding)
            .filter(TaskExecutionBinding.loop_item_id == item_id)
            .first()
        )
        if binding is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Task execution binding no longer exists",
            )
        return binding

    def _validate_project_agents(
        self,
        db: Session,
        *,
        project_id: int,
        agent_ids: list[str],
    ) -> None:
        rows = (
            db.query(ProjectChatAgent.id)
            .filter(
                ProjectChatAgent.cloud_project_id == str(project_id),
                ProjectChatAgent.id.in_(agent_ids),
                ProjectChatAgent.status == "active",
                loop_datetime_is_unset(ProjectChatAgent.deleted_at),
            )
            .all()
        )
        found = {str(row[0]) for row in rows}
        missing = sorted(set(agent_ids) - found)
        if missing:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Project agents not found: {', '.join(missing)}",
            )

    @staticmethod
    def _require_task(db: Session, project_id: int, item_id: str) -> LoopItem:
        item = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == item_id,
                LoopItem.cloud_project_id == str(project_id),
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .first()
        )
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
        return item

    @staticmethod
    def _get_agent(
        db: Session,
        project_id: int,
        agent_id: str,
    ) -> ProjectChatAgent:
        row = (
            db.query(ProjectChatAgent)
            .filter(
                ProjectChatAgent.id == agent_id,
                ProjectChatAgent.cloud_project_id == str(project_id),
                ProjectChatAgent.status == "active",
                loop_datetime_is_unset(ProjectChatAgent.deleted_at),
            )
            .first()
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project agent not found")
        return row

    @staticmethod
    def _get_squad(
        db: Session,
        project_id: int,
        squad_id: str,
        *,
        active_only: bool = True,
    ) -> ProjectAgentSquad:
        query = db.query(ProjectAgentSquad).filter(
            ProjectAgentSquad.id == squad_id,
            ProjectAgentSquad.cloud_project_id == str(project_id),
        )
        if active_only:
            query = query.filter(ProjectAgentSquad.status == "active")
        row = query.first()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Squad not found")
        return row

    @staticmethod
    def _get_repository(
        db: Session,
        project_id: int,
        binding_id: str,
        *,
        active_only: bool = True,
    ) -> ProjectRepositoryBinding:
        query = db.query(ProjectRepositoryBinding).filter(
            ProjectRepositoryBinding.id == binding_id,
            ProjectRepositoryBinding.cloud_project_id == str(project_id),
        )
        if active_only:
            query = query.filter(ProjectRepositoryBinding.status == "active")
        row = query.first()
        if row is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Repository binding not found",
            )
        return row

    @staticmethod
    def _get_workflow(
        db: Session,
        project_id: int,
        workflow_id: str,
        *,
        active_only: bool = True,
    ) -> ProjectWorkflowDefinition:
        query = db.query(ProjectWorkflowDefinition).filter(
            ProjectWorkflowDefinition.id == workflow_id,
            ProjectWorkflowDefinition.cloud_project_id == str(project_id),
        )
        if active_only:
            query = query.filter(ProjectWorkflowDefinition.status == "active")
        row = query.first()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workflow not found")
        return row

    @staticmethod
    def _get_run(
        db: Session,
        *,
        item_id: str,
        run_id: str,
    ) -> TaskWorkflowRun:
        row = (
            db.query(TaskWorkflowRun)
            .filter(
                TaskWorkflowRun.id == run_id,
                TaskWorkflowRun.loop_item_id == item_id,
            )
            .first()
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workflow run not found")
        return row

    @staticmethod
    def _get_stage(
        db: Session,
        *,
        run_id: str,
        stage_id: str,
    ) -> TaskStageRun:
        row = (
            db.query(TaskStageRun)
            .filter(
                TaskStageRun.id == stage_id,
                TaskStageRun.workflow_run_id == run_id,
            )
            .first()
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Stage run not found")
        return row

    @staticmethod
    def _clear_default_workflows(db: Session, project_id: int) -> None:
        db.query(ProjectWorkflowDefinition).filter(
            ProjectWorkflowDefinition.cloud_project_id == str(project_id),
            ProjectWorkflowDefinition.is_default == 1,
        ).update({"is_default": 0}, synchronize_session=False)
