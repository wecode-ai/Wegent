# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Versioned planning and task materialization for AI-coordinated Issues."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    ProjectWorkflowPlanItem,
    ProjectWorkflowRun,
    loop_datetime_is_unset,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemCreate
from app.schemas.issue_workflow import (
    ISSUE_WORKFLOW_SCOPE_ID,
    WorkflowManagerRunView,
    WorkflowPlanItemCreate,
    WorkflowPlanItemView,
    WorkflowPlanSubmit,
    WorkflowPlanView,
    WorkflowTaskOutcomeSubmit,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.cloud_projects.service import cloud_project_service
from app.services.issue_workflow_plan_assignment import (
    workflow_plan_assignee_payload,
)
from app.services.loop_item_executions.service import (
    ACTIVE_STATUSES,
    loop_item_execution_service,
)
from app.services.loop_item_status_history import write_status_change
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_domain import runnable_wegent_team


class IssueWorkflowPlanningService:
    """Persist plans and turn an approved version into child tasks once."""

    def ensure_run(
        self,
        db: Session,
        *,
        issue: LoopItem,
        user_id: int,
    ) -> ProjectWorkflowRun:
        workflow = self._workflow(issue)
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
                "current_stage_id": (
                    stage_id if stage_id != ISSUE_WORKFLOW_SCOPE_ID else None
                ),
            }
        )
        self._write_workflow(issue, workflow)
        db.flush()
        return run

    def submit(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
        values: WorkflowPlanSubmit,
        commit: bool = True,
    ) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, for_update=True)
        workflow = self._workflow(issue)
        if workflow.get("advancement_policy") != "ai":
            raise ValueError("Issue is not configured for AI coordination")
        run = self.ensure_run(db, issue=issue, user_id=user_id)
        workflow = self._workflow(issue)
        if run.status not in {"planning", "failed"}:
            raise ValueError("The active workflow run is not accepting a plan")
        stage_id = self._run_stage(run)
        self._validate_stage(workflow, stage_id)
        items = [
            item.model_copy(update={"stage_id": stage_id}) for item in values.items
        ]
        for item in items:
            self._validate_assignee(db, issue, user_id, item)
        self._supersede_items(db, run.id)
        for order, item in enumerate(items):
            db.add(
                ProjectWorkflowPlanItem(
                    cloud_project_id=issue.cloud_project_id,
                    parent_id=run.id,
                    title=item.title,
                    description=item.description,
                    status="proposed",
                    sort_order=order,
                    created_by_user_id=user_id,
                    updated_by_user_id=user_id,
                    metadata_json=item.model_dump(),
                )
            )
        approval_policy = str(workflow.get("approval_policy") or "required")
        run.description = values.summary
        run.status = (
            "awaiting_approval" if approval_policy == "required" else "dispatching"
        )
        run.version += 1
        workflow["orchestration_status"] = run.status
        self._write_workflow(issue, workflow)
        if commit:
            db.commit()
        else:
            db.flush()
        db.refresh(run)
        return self._view(db, issue, run)

    def approve(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
    ) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, for_update=True)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        if run is None:
            raise ValueError("The Issue has no active workflow plan")
        if run.status == "running":
            return self._view(db, issue, run)
        if run.status not in {"awaiting_approval", "dispatching"}:
            raise ValueError("The workflow plan is not ready for execution")
        items = self._items(db, run.id)
        if not items:
            raise ValueError("The workflow plan has no items")
        run.status = "dispatching"
        workflow["orchestration_status"] = "dispatching"
        self._write_workflow(issue, workflow)
        db.flush()
        run_metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
        automation_run_id = str(run_metadata.get("project_automation_run_id") or "")
        for item in items:
            if item.loop_item_id:
                continue
            child = loop_item_service.create(
                db,
                int(str(issue.cloud_project_id)),
                user_id,
                LoopItemCreate(
                    title=item.title or "",
                    description=item.description or "",
                    status="pending",
                    parent_id=issue.id,
                    priority=issue.priority or "none",
                    **workflow_plan_assignee_payload(item),
                ),
                commit=False,
                automation_context={
                    "source": "issue_workflow",
                    "workflow_run_id": run.id,
                    "plan_version": self._plan_version(run),
                    "plan_item_id": item.id,
                    **({"run_id": automation_run_id} if automation_run_id else {}),
                },
                instruction=item.description or "",
                assign_creator_if_unassigned=False,
            )
            child.metadata_json = {
                **(child.metadata_json or {}),
                "workflow_plan": {
                    "run_id": run.id,
                    "plan_version": self._plan_version(run),
                    "plan_item_id": item.id,
                    "client_key": self._item_metadata(item).get("client_key"),
                    "stage_id": self._run_stage(run),
                },
            }
            item.loop_item_id = child.id
            item.status = "materialized"
            item.version += 1
        run.status = "running"
        run.version += 1
        workflow["orchestration_status"] = "running"
        self._write_workflow(issue, workflow)
        self._set_item_status(
            db,
            issue,
            "in_progress",
            trigger="workflow_plan_approved",
            by_user_id=user_id,
        )
        db.commit()
        db.refresh(run)
        return self._view(db, issue, run)

    def approve_review(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
    ) -> WorkflowPlanView:
        """Accept all reviewed child tasks and advance the parent once."""

        issue = self._issue(db, issue_id, user_id, for_update=True)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        if run is None:
            raise ValueError("The Issue has no active workflow plan")
        tasks = self._plan_tasks(db, run.id)
        if not tasks:
            raise ValueError("The workflow plan has no materialized tasks")
        if any(task.status not in {"in_review", "completed"} for task in tasks):
            raise ValueError("Workflow tasks are not all ready for review")
        for task in tasks:
            self._set_item_status(
                db,
                task,
                "completed",
                trigger="workflow_review_approved",
                by_user_id=user_id,
            )
        run.status = "completed"
        run.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
        run.version += 1
        has_next_stage = self._complete_stage(workflow, self._run_stage(run))
        if has_next_stage:
            workflow.update(
                {
                    "orchestration_status": "planning",
                    "active_run_id": None,
                    "current_stage_id": None,
                }
            )
            self._write_workflow(issue, workflow)
            self._set_item_status(
                db,
                issue,
                "in_progress",
                trigger="workflow_stage_advanced",
                by_user_id=user_id,
            )
            next_run = self.ensure_run(db, issue=issue, user_id=user_id)
            db.commit()
            db.refresh(next_run)
            return self._view(db, issue, next_run)
        workflow["orchestration_status"] = "completed"
        self._write_workflow(issue, workflow)
        self._set_item_status(
            db,
            issue,
            "completed",
            trigger="workflow_review_approved",
            by_user_id=user_id,
        )
        db.commit()
        db.refresh(run)
        return self._view(db, issue, run)

    def report_outcome(
        self,
        db: Session,
        *,
        child_id: str,
        user_id: int,
        values: WorkflowTaskOutcomeSubmit,
    ) -> WorkflowPlanView:
        """Record an executor verdict and return the current parent plan."""

        child = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == child_id,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .with_for_update()
            .one_or_none()
        )
        if child is None or not child.parent_id:
            raise ValueError("Workflow task not found")
        issue = self._issue(db, child.parent_id, user_id, for_update=True)
        plan_metadata = self._child_plan_metadata(child)
        run_id = str(plan_metadata.get("run_id") or "")
        plan_item_id = str(plan_metadata.get("plan_item_id") or "")
        run = db.get(ProjectWorkflowRun, run_id)
        plan_item = db.get(ProjectWorkflowPlanItem, plan_item_id)
        if (
            run is None
            or run.parent_id != issue.id
            or plan_item is None
            or plan_item.parent_id != run.id
            or plan_item.loop_item_id != child.id
        ):
            raise ValueError("Workflow task plan binding is unavailable")
        metadata = dict(child.metadata_json or {})
        existing = metadata.get("workflow_outcome")
        outcome = values.model_dump()
        if existing == outcome:
            current = self.get(db, issue_id=issue.id, user_id=user_id)
            if current is None:
                raise ValueError("The Issue has no active workflow plan")
            return current
        metadata["workflow_outcome"] = outcome
        child.metadata_json = metadata
        child.version += 1
        self._set_item_status(
            db,
            child,
            "in_review",
            trigger=f"workflow_outcome_{values.verdict}",
            by_user_id=user_id,
        )
        if values.verdict == "needs_rework":
            db.commit()
            replanned = self.replan(
                db,
                issue_id=issue.id,
                user_id=user_id,
            )
            next_run = db.get(ProjectWorkflowRun, replanned.run_id)
            if next_run is not None:
                next_run.metadata_json = {
                    **(next_run.metadata_json or {}),
                    "rework_context": {
                        "source_task_id": child.id,
                        **outcome,
                    },
                }
                db.commit()
                db.refresh(next_run)
                return self._view(db, issue, next_run)
            return replanned
        self.sync_from_child(db, child_id=child.id, commit=True)
        current = self.get(db, issue_id=issue.id, user_id=user_id)
        if current is None:
            raise ValueError("The Issue has no active workflow plan")
        return current

    def sync_from_child(
        self,
        db: Session,
        *,
        child_id: str,
        commit: bool = False,
    ) -> LoopItem | None:
        """Project child task progress onto the parent Issue and plan run."""

        child = db.get(LoopItem, child_id)
        if child is None or not child.parent_id:
            return None
        plan_metadata = self._child_plan_metadata(child)
        run_id = str(plan_metadata.get("run_id") or "")
        if not run_id:
            return None
        issue = db.get(LoopItem, child.parent_id)
        run = db.get(ProjectWorkflowRun, run_id)
        if issue is None or run is None or run.parent_id != issue.id:
            return None
        workflow = self._workflow(issue)
        if workflow.get("active_run_id") != run.id or run.status in {
            "paused",
            "failed",
            "completed",
        }:
            return issue
        tasks = self._plan_tasks(db, run.id)
        if not tasks:
            return issue
        if all(task.status in {"in_review", "completed"} for task in tasks):
            next_status = "awaiting_review"
            parent_status = "in_review"
        else:
            next_status = "running"
            parent_status = "in_progress"
        if run.status != next_status:
            run.status = next_status
            run.version += 1
        workflow["orchestration_status"] = next_status
        self._write_workflow(issue, workflow)
        self._set_item_status(
            db,
            issue,
            parent_status,
            trigger="workflow_task_progress",
            by_user_id=None,
        )
        if commit:
            db.commit()
            db.refresh(issue)
        else:
            db.flush()
        return issue

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

    def pause(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
    ) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, for_update=True)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        if run is None:
            raise ValueError("The Issue has no active workflow plan")
        if run.status in {"completed", "failed"}:
            raise ValueError("The workflow plan cannot be paused")
        if run.status == "paused":
            return self._view(db, issue, run)
        cancelled_executions = self._pause_materialized_tasks(
            db,
            run,
            user_id=user_id,
        )
        run.status = "paused"
        run.version += 1
        workflow["orchestration_status"] = "paused"
        self._write_workflow(issue, workflow)
        db.commit()
        if cancelled_executions:
            from app.services.board_team_execution import (
                request_execution_cancellations,
            )

            request_execution_cancellations(cancelled_executions)
        db.refresh(run)
        return self._view(db, issue, run)

    def resume(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
    ) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, for_update=True)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        if run is None:
            run = self.ensure_run(db, issue=issue, user_id=user_id)
        elif run.status == "paused":
            items = self._items(db, run.id)
            tasks = self._plan_tasks(db, run.id)
            if items and all(item.loop_item_id for item in items):
                self._restart_unfinished_tasks(db, tasks, user_id=user_id)
                if tasks and all(
                    task.status in {"in_review", "completed"} for task in tasks
                ):
                    run.status = "awaiting_review"
                    parent_status = "in_review"
                else:
                    run.status = "running"
                    parent_status = "in_progress"
                self._set_item_status(
                    db,
                    issue,
                    parent_status,
                    trigger="workflow_resumed",
                    by_user_id=user_id,
                )
            else:
                run.status = "awaiting_approval" if items else "planning"
            run.version += 1
            workflow["orchestration_status"] = run.status
            self._write_workflow(issue, workflow)
        db.commit()
        db.refresh(run)
        return self._view(db, issue, run)

    def replan(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
    ) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, for_update=True)
        workflow = self._workflow(issue)
        current = self._active_run(db, issue, workflow)
        cancelled_executions: list[LoopItemExecution] = []
        if current is not None and current.status != "completed":
            cancelled_executions = self._supersede_materialized_tasks(
                db,
                current,
                user_id=user_id,
            )
            current.status = "failed"
            current.metadata_json = {
                **(current.metadata_json or {}),
                "superseded": True,
            }
            current.version += 1
            self._supersede_items(db, current.id, proposed_only=True)
        workflow["active_run_id"] = None
        self._write_workflow(issue, workflow)
        run = self.ensure_run(db, issue=issue, user_id=user_id)
        if issue.status == "completed":
            self._set_item_status(
                db,
                issue,
                "pending",
                trigger="workflow_replanned",
                by_user_id=user_id,
            )
        db.commit()
        if cancelled_executions:
            from app.services.board_team_execution import (
                request_execution_cancellations,
            )

            request_execution_cancellations(cancelled_executions)
        db.refresh(run)
        return self._view(db, issue, run)

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
            query = query.with_for_update()
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
    def _validate_stage(workflow: dict, stage_id: str) -> None:
        if workflow.get("stage_mode") != "dag":
            if stage_id != ISSUE_WORKFLOW_SCOPE_ID:
                raise ValueError("Invalid Issue planning scope")
            return
        stage = next(
            (
                node
                for node in workflow.get("nodes", [])
                if isinstance(node, dict) and str(node.get("id")) == stage_id
            ),
            None,
        )
        if stage is None or stage.get("status") != "ready":
            raise ValueError("Workflow plan selected a stage that is not ready")

    @staticmethod
    def _validate_assignee(
        db: Session,
        issue: LoopItem,
        user_id: int,
        item: WorkflowPlanItemCreate,
    ) -> None:
        if item.assignee_type == "user":
            members = cloud_project_service.list_members(
                db,
                int(str(issue.cloud_project_id)),
                user_id,
            )
            if item.assignee_id not in {str(member["user_id"]) for member in members}:
                raise ValueError("Workflow plan selected an unavailable member")
        elif item.assignee_type == "agent":
            agent = db.get(ProjectChatAgent, item.assignee_id)
            if (
                agent is None
                or str(agent.cloud_project_id) != str(issue.cloud_project_id)
                or agent.status != "active"
            ):
                raise ValueError("Workflow plan selected an unavailable robot")
        else:
            runnable_wegent_team(db, user_id, int(item.assignee_id))

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

    def _plan_tasks(self, db: Session, run_id: str) -> list[LoopItem]:
        task_ids = [
            item.loop_item_id
            for item in self._items(db, run_id)
            if item.status == "materialized" and item.loop_item_id
        ]
        if not task_ids:
            return []
        tasks = (
            db.query(LoopItem)
            .filter(
                LoopItem.id.in_(task_ids),
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .all()
        )
        by_id = {task.id: task for task in tasks}
        return [by_id[task_id] for task_id in task_ids if task_id in by_id]

    def _supersede_materialized_tasks(
        self,
        db: Session,
        run: ProjectWorkflowRun,
        *,
        user_id: int,
    ) -> list[LoopItemExecution]:
        cancelled: list[LoopItemExecution] = []
        for task in self._plan_tasks(db, run.id):
            metadata = dict(task.metadata_json or {})
            plan_metadata = self._child_plan_metadata(task)
            metadata["workflow_plan"] = {
                **plan_metadata,
                "superseded": True,
            }
            task.metadata_json = metadata
            if task.status != "completed":
                self._set_item_status(
                    db,
                    task,
                    "completed",
                    trigger="workflow_replanned",
                    by_user_id=user_id,
                )
            # Execution cancellation expires the SQLAlchemy identity map after
            # its conditional update. Persist the superseded task first so the
            # expiration cannot discard its status and metadata changes.
            db.flush()
            executions = (
                db.query(LoopItemExecution)
                .filter(
                    LoopItemExecution.loop_item_id == task.id,
                    LoopItemExecution.status.in_(
                        {
                            "pending_approval",
                            "queued",
                            "claimed",
                            "running",
                            "cancel_requested",
                        }
                    ),
                )
                .all()
            )
            for execution in executions:
                stopped = loop_item_execution_service.cancel(
                    db,
                    execution_id=execution.id,
                    note="Workflow plan was superseded",
                    commit=False,
                )
                if (
                    stopped.status == "cancel_requested"
                    and stopped.runtime_device_id
                    and stopped.runtime_task_id
                ) or (stopped.team_id and stopped.backend_task_id):
                    cancelled.append(stopped)
        return cancelled

    def _pause_materialized_tasks(
        self,
        db: Session,
        run: ProjectWorkflowRun,
        *,
        user_id: int,
    ) -> list[LoopItemExecution]:
        cancelled: list[LoopItemExecution] = []
        for task in self._plan_tasks(db, run.id):
            if task.status not in {"in_review", "completed"}:
                self._set_item_status(
                    db,
                    task,
                    "pending",
                    trigger="workflow_paused",
                    by_user_id=user_id,
                )
            db.flush()
            executions = self._active_task_executions(db, task.id)
            for execution in executions:
                stopped = loop_item_execution_service.cancel(
                    db,
                    execution_id=execution.id,
                    note="Workflow was paused",
                    commit=False,
                )
                if (
                    stopped.status == "cancel_requested"
                    and stopped.runtime_device_id
                    and stopped.runtime_task_id
                ) or (stopped.team_id and stopped.backend_task_id):
                    cancelled.append(stopped)
        return cancelled

    def _restart_unfinished_tasks(
        self,
        db: Session,
        tasks: list[LoopItem],
        *,
        user_id: int,
    ) -> None:
        targets: list[tuple[LoopItem, ProjectChatAgent | Kind | None]] = []
        for task in tasks:
            if task.status in {"in_review", "completed"}:
                continue
            if self._active_task_executions(db, task.id):
                raise ValueError("Workflow tasks are still stopping")
            if task.assignee_agent_id:
                target = db.get(ProjectChatAgent, task.assignee_agent_id)
                if (
                    target is None
                    or target.status != "active"
                    or str(target.cloud_project_id) != str(task.cloud_project_id)
                ):
                    raise ValueError("Workflow task robot is unavailable")
            elif task.assignee_team_id:
                target = runnable_wegent_team(
                    db,
                    user_id,
                    int(task.assignee_team_id),
                )
            else:
                target = None
            targets.append((task, target))

        for task, target in targets:
            if isinstance(target, ProjectChatAgent):
                from app.services.project_chat.service import bot_config

                config = bot_config(target)
                loop_item_execution_service.create_for_assignment(
                    db,
                    loop_item_id=task.id,
                    cloud_project_id=task.cloud_project_id,
                    agent=target,
                    assigner_user_id=user_id,
                    environment=str(config.get("execution_environment") or "local"),
                    execution_device_id=(
                        config.get("execution_device_id")
                        if isinstance(config.get("execution_device_id"), str)
                        else None
                    ),
                    priority=task.priority,
                )
            elif isinstance(target, Kind):
                loop_item_execution_service.create_for_team_assignment(
                    db,
                    loop_item_id=task.id,
                    cloud_project_id=task.cloud_project_id,
                    team=target,
                    assigner_user_id=user_id,
                    priority=task.priority,
                )

    @staticmethod
    def _active_task_executions(
        db: Session,
        task_id: str,
    ) -> list[LoopItemExecution]:
        return (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == task_id,
                LoopItemExecution.status.in_(ACTIVE_STATUSES),
            )
            .order_by(LoopItemExecution.id)
            .all()
        )

    def _supersede_items(
        self,
        db: Session,
        run_id: str,
        *,
        proposed_only: bool = False,
    ) -> None:
        for item in self._items(db, run_id):
            if proposed_only and item.loop_item_id:
                continue
            item.status = "superseded"
            item.version += 1

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

    @staticmethod
    def _child_plan_metadata(child: LoopItem) -> dict:
        metadata = child.metadata_json if isinstance(child.metadata_json, dict) else {}
        value = metadata.get("workflow_plan")
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _set_item_status(
        db: Session,
        item: LoopItem,
        next_status: str,
        *,
        trigger: str,
        by_user_id: int | None,
    ) -> None:
        if item.status == next_status:
            return
        project = db.get(CloudProject, item.cloud_project_id)
        metadata = dict(item.metadata_json or {})
        if project is not None:
            write_status_change(
                metadata,
                project=project,
                from_status=item.status,
                to_status=next_status,
                trigger=trigger,
                by_user_id=by_user_id,
            )
        item.metadata_json = metadata
        item.status = next_status
        item.sort_order = 0
        item.completed_at = (
            datetime.now(timezone.utc).replace(tzinfo=None)
            if next_status == "completed"
            else None
        )
        item.version += 1

    @staticmethod
    def _complete_stage(workflow: dict, stage_id: str) -> bool:
        if workflow.get("stage_mode") != "dag":
            return False
        nodes = [
            dict(node) for node in workflow.get("nodes", []) if isinstance(node, dict)
        ]
        for node in nodes:
            if str(node.get("id")) == stage_id:
                node["status"] = "completed"
        completed = {
            str(node.get("id"))
            for node in nodes
            if node.get("status") in {"completed", "forced_completed"}
        }
        for node in nodes:
            dependencies = node.get("depends_on")
            dependencies = dependencies if isinstance(dependencies, list) else []
            if node.get("status") == "blocked" and all(
                str(dependency) in completed for dependency in dependencies
            ):
                node["status"] = "ready"
        workflow["nodes"] = nodes
        required = [node for node in nodes if node.get("required", True)]
        return any(
            node.get("status") not in {"completed", "forced_completed"}
            for node in required
        )

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
