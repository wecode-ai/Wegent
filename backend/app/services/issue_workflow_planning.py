# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Coordinator turns and read-only historical plans for Issue assignment."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectWorkflowPlanItem,
    ProjectWorkflowRun,
    loop_datetime_is_unset,
)
from app.schemas.base_role import BaseRole
from app.schemas.issue_workflow import (
    ISSUE_WORKFLOW_SCOPE_ID,
    WorkflowManagerRunView,
    WorkflowPlanItemView,
    WorkflowPlanView,
)
from app.services.cloud_projects.access import require_cloud_project_role


class IssueWorkflowPlanningService:
    """Track coordinator turns without creating child Issues."""

    def ensure_run(
        self,
        db: Session,
        *,
        issue: LoopItem,
        user_id: int,
    ) -> ProjectWorkflowRun:
        workflow = self._workflow(issue)
        self._require_current_experience(workflow)
        if (workflow.get("assignment") or {}).get("status") == "waiting_human":
            raise ValueError("Only the assigned person's Continue action can resume AI")
        current = self._active_run(db, issue, workflow)
        if current is not None and current.status not in {"completed", "failed"}:
            return current
        stage_id = self._planning_stage(workflow)
        version = int(workflow.get("active_plan_version") or 0) + 1
        run = ProjectWorkflowRun(
            cloud_project_id=issue.cloud_project_id,
            parent_id=issue.id,
            title=issue.title or "Issue workflow",
            status="planning",
            source="ai",
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            metadata_json={
                "stage_id": stage_id,
                "plan_version": version,
            },
        )
        db.add(run)
        db.flush()
        workflow.update(
            {
                "orchestration_status": "planning",
                "active_run_id": run.id,
                "active_plan_version": version,
            }
        )
        self._write_workflow(issue, workflow)
        db.flush()
        return run

    def get(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
    ) -> WorkflowPlanView | None:
        issue = self._issue(db, issue_id, user_id)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        return self._view(db, issue, run) if run is not None else None

    def manager_automation_run(
        self,
        db: Session,
        *,
        workflow_run_id: str,
    ) -> ProjectAutomationRun | None:
        run = db.get(ProjectWorkflowRun, workflow_run_id)
        if run is None:
            return None
        metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
        automation_run_id = str(metadata.get("project_automation_run_id") or "")
        if automation_run_id:
            automation_run = db.get(ProjectAutomationRun, automation_run_id)
            if automation_run is not None:
                return automation_run
        candidates = (
            db.query(ProjectAutomationRun)
            .filter(
                ProjectAutomationRun.cloud_project_id == run.cloud_project_id,
                ProjectAutomationRun.task_id == run.parent_id,
                loop_datetime_is_unset(ProjectAutomationRun.deleted_at),
            )
            .order_by(ProjectAutomationRun.created_at.desc())
            .all()
        )
        for candidate in candidates:
            candidate_metadata = (
                candidate.metadata_json
                if isinstance(candidate.metadata_json, dict)
                else {}
            )
            event = candidate_metadata.get("event")
            payload = event.get("payload") if isinstance(event, dict) else None
            if (
                isinstance(payload, dict)
                and str(payload.get("workflow_run_id") or "") == workflow_run_id
            ):
                return candidate
        return None

    def pause(self, db: Session, *, issue_id: str, user_id: int) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, for_update=True)
        workflow = self._workflow(issue)
        self._require_current_experience(workflow)
        if workflow.get("orchestration_status") == "completed":
            raise ValueError("The Issue automation is complete")
        run = self._active_run(db, issue, workflow)
        if run is None:
            raise ValueError("The Issue has no coordinator turn")
        workflow["orchestration_status"] = "paused"
        if not (workflow.get("assignment") or {}).get("status"):
            run.status = "paused"
        self._write_workflow(issue, workflow)
        db.commit()
        return self._view(db, issue, run)

    def resume(self, db: Session, *, issue_id: str, user_id: int) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, for_update=True)
        workflow = self._workflow(issue)
        self._require_current_experience(workflow)
        if workflow.get("orchestration_status") != "paused":
            raise ValueError("The Issue automation is not paused")
        assignment = workflow.get("assignment") or {}
        if assignment.get("status") in {"running", "dispatching", "waiting_human"}:
            workflow["orchestration_status"] = assignment["status"]
            run = self._active_run(db, issue, workflow)
            self._write_workflow(issue, workflow)
        else:
            workflow.update(orchestration_status="planning", active_run_id=None)
            self._write_workflow(issue, workflow)
            run = self.ensure_run(db, issue=issue, user_id=user_id)
        db.commit()
        return self._view(db, issue, run)

    def replan(self, db: Session, *, issue_id: str, user_id: int) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, for_update=True)
        workflow = self._workflow(issue)
        self._require_current_experience(workflow)
        if workflow.get("orchestration_status") in {"completed", "paused"}:
            raise ValueError("Resume the automation before requesting a new decision")
        if (workflow.get("assignment") or {}).get("status") in {
            "running",
            "dispatching",
            "waiting_human",
        }:
            raise ValueError("The current assignment must finish first")
        workflow.update(active_run_id=None, orchestration_status="planning")
        self._write_workflow(issue, workflow)
        run = self.ensure_run(db, issue=issue, user_id=user_id)
        db.commit()
        return self._view(db, issue, run)

    @staticmethod
    def _require_current_experience(workflow: dict) -> None:
        if workflow.get("migration_required"):
            raise ValueError(
                "Select a reviewed experience before continuing this Issue"
            )

    @staticmethod
    def _issue(
        db: Session,
        issue_id: str,
        user_id: int,
        *,
        for_update: bool = False,
    ) -> LoopItem:
        query = db.query(LoopItem).filter(
            LoopItem.id == issue_id,
            loop_datetime_is_unset(LoopItem.deleted_at),
        )
        if for_update:
            query = query.populate_existing().with_for_update()
        issue = query.one_or_none()
        if issue is None:
            raise ValueError("Issue not found")
        require_cloud_project_role(
            db,
            int(str(issue.cloud_project_id)),
            user_id,
            BaseRole.Developer,
        )
        return issue

    @staticmethod
    def _workflow(issue: LoopItem) -> dict:
        metadata = issue.metadata_json if isinstance(issue.metadata_json, dict) else {}
        workflow = metadata.get("workflow")
        if not isinstance(workflow, dict):
            raise ValueError("Issue has no workflow snapshot")
        return dict(workflow)

    @staticmethod
    def _write_workflow(issue: LoopItem, workflow: dict) -> None:
        metadata = dict(issue.metadata_json or {})
        workflow["version"] = int(workflow.get("version") or 1) + 1
        metadata["workflow"] = workflow
        issue.metadata_json = metadata
        issue.version += 1

    @staticmethod
    def _planning_stage(workflow: dict) -> str:
        if workflow.get("advancement_policy") == "ai":
            return ISSUE_WORKFLOW_SCOPE_ID
        if workflow.get("stage_mode") != "dag":
            return ISSUE_WORKFLOW_SCOPE_ID
        ready = next(
            (
                node
                for node in workflow.get("nodes", [])
                if isinstance(node, dict) and node.get("status") == "ready"
            ),
            None,
        )
        if ready is None:
            raise ValueError("Issue workflow has no ready stage")
        return str(ready["id"])

    @staticmethod
    def _active_run(
        db: Session,
        issue: LoopItem,
        workflow: dict,
    ) -> ProjectWorkflowRun | None:
        run_id = workflow.get("active_run_id")
        if not isinstance(run_id, str) or not run_id:
            return None
        run = db.get(ProjectWorkflowRun, run_id)
        if (
            run is None
            or run.parent_id != issue.id
            or str(run.cloud_project_id) != str(issue.cloud_project_id)
        ):
            raise ValueError("The active workflow run is unavailable")
        return run

    @staticmethod
    def _items(db: Session, run_id: str) -> list[ProjectWorkflowPlanItem]:
        return (
            db.query(ProjectWorkflowPlanItem)
            .filter(
                ProjectWorkflowPlanItem.parent_id == run_id,
                loop_datetime_is_unset(ProjectWorkflowPlanItem.deleted_at),
            )
            .order_by(ProjectWorkflowPlanItem.sort_order, ProjectWorkflowPlanItem.id)
            .all()
        )

    @staticmethod
    def _run_stage(run: ProjectWorkflowRun) -> str:
        metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
        return str(metadata.get("stage_id") or "")

    @staticmethod
    def _plan_version(run: ProjectWorkflowRun) -> int:
        metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
        return int(metadata.get("plan_version") or 1)

    @staticmethod
    def _item_metadata(item: ProjectWorkflowPlanItem) -> dict:
        return item.metadata_json if isinstance(item.metadata_json, dict) else {}

    def _view(
        self,
        db: Session,
        issue: LoopItem,
        run: ProjectWorkflowRun,
    ) -> WorkflowPlanView:
        workflow = self._workflow(issue)
        items = [
            item for item in self._items(db, run.id) if item.status != "superseded"
        ]
        task_ids = [item.loop_item_id for item in items if item.loop_item_id]
        tasks = (
            {
                task.id: task
                for task in db.query(LoopItem)
                .filter(
                    LoopItem.id.in_(task_ids),
                    loop_datetime_is_unset(LoopItem.deleted_at),
                )
                .all()
            }
            if task_ids
            else {}
        )
        manager_run = self.manager_automation_run(db, workflow_run_id=run.id)
        manager_view = self._manager_view(db, manager_run)
        return WorkflowPlanView(
            run_id=run.id,
            issue_id=issue.id,
            stage_id=self._run_stage(run),
            plan_version=self._plan_version(run),
            approval_policy=str(workflow.get("approval_policy") or "required"),
            status=run.status,
            summary=run.description or "",
            items=[
                WorkflowPlanItemView(
                    id=item.id,
                    **self._item_metadata(item),
                    task_id=item.loop_item_id or None,
                    task_status=(
                        tasks[item.loop_item_id].status
                        if item.loop_item_id in tasks
                        else None
                    ),
                    **self._outcome_view(tasks.get(item.loop_item_id)),
                    status=item.status,
                )
                for item in items
            ],
            manager_run=manager_view,
        )

    @staticmethod
    def _outcome_view(task: LoopItem | None) -> dict[str, str | None]:
        metadata = (
            task.metadata_json if task and isinstance(task.metadata_json, dict) else {}
        )
        outcome = metadata.get("workflow_outcome")
        if not isinstance(outcome, dict):
            return {"outcome_verdict": None, "outcome_summary": ""}
        verdict = str(outcome.get("verdict") or "")
        return {
            "outcome_verdict": (
                verdict if verdict in {"passed", "needs_rework"} else None
            ),
            "outcome_summary": str(outcome.get("summary") or ""),
        }

    @staticmethod
    def _manager_view(
        db: Session,
        run: ProjectAutomationRun | None,
    ) -> WorkflowManagerRunView | None:
        if run is None:
            return None
        rule = db.get(ProjectAutomationRule, run.parent_id)
        metadata = (
            rule.metadata_json if rule and isinstance(rule.metadata_json, dict) else {}
        )
        model = metadata.get("model")
        environment = metadata.get("execution_environment")
        device_id = run.device_id or metadata.get("execution_device_id")
        recent_activity = ""
        if run.status == "failed":
            recent_activity = "AI 管家执行失败"
        elif run.status in {"pending", "queued", "waiting_device"}:
            recent_activity = "等待执行器领取"
        elif run.status == "running":
            recent_activity = "正在读取 Issue 并生成编排方案"
        elif run.status in {"completed", "succeeded"}:
            recent_activity = "方案生成完成"
        elif run.status in {"cancelled", "canceled"}:
            recent_activity = "执行已停止"
        return WorkflowManagerRunView(
            id=run.id,
            status=run.status,
            model=str(model) if model else None,
            execution_environment=str(environment) if environment else None,
            device_id=str(device_id) if device_id else None,
            recent_activity=recent_activity,
            error=run.description if run.status == "failed" else None,
            updated_at=run.updated_at,
        )


issue_workflow_planning_service = IssueWorkflowPlanningService()
