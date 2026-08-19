# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Durable plan, approval, and recovery operations for AI-coordinated Issues."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectChatAgent,
    ProjectWorkflowPlanItem,
    ProjectWorkflowRun,
    loop_datetime_is_unset,
)
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.schemas.issue_workflow import (
    ISSUE_WORKFLOW_SCOPE_ID,
    WorkflowPlanItemCreate,
    WorkflowPlanItemView,
    WorkflowPlanSubmit,
    WorkflowPlanView,
    WorkflowTaskOutcomeSubmit,
)
from app.services.cloud_projects.access import BaseRole, require_cloud_project_role
from app.services.cloud_projects.service import cloud_project_service
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_domain import runnable_wegent_team


@dataclass(frozen=True)
class WorkflowOutcomeResult:
    """Persisted outcome plus the information needed to dispatch one replan."""

    plan: WorkflowPlanView
    replan_started: bool
    project_id: str
    automation_id: str | None
    event_payload: dict


@dataclass(frozen=True)
class WorkflowDispatchRequest:
    """One coordinator dispatch derived from the persisted Issue snapshot."""

    plan: WorkflowPlanView
    project_id: str
    automation_id: str
    event_payload: dict


class ProjectWorkflowOrchestrationService:
    """Persist plan versions and materialize approved tasks idempotently."""

    def get_plan(
        self, db: Session, *, issue_id: str, user_id: int
    ) -> WorkflowPlanView | None:
        issue = self._issue(db, issue_id, user_id, BaseRole.Reporter)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        return self._view(db, issue, run) if run is not None else None

    def submit_plan(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
        values: WorkflowPlanSubmit,
    ) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, BaseRole.Developer, for_update=True)
        workflow = self._workflow(issue)
        if workflow.get("advancement_policy") != "ai":
            raise ValueError("Issue is not configured for AI coordination")
        run = self._active_or_new_run(db, issue, workflow, user_id)
        if run.status not in {"planning", "failed"}:
            raise ValueError("The active workflow run is not accepting a plan")
        stage_id = self._run_stage(run)
        if self._uses_stage_dag(workflow):
            stage_ids = {
                str(node.get("id"))
                for node in workflow.get("nodes", [])
                if isinstance(node, dict) and node.get("id")
            }
            if stage_id not in stage_ids:
                raise ValueError("The active workflow stage no longer exists")
        elif stage_id != ISSUE_WORKFLOW_SCOPE_ID:
            raise ValueError("The active Issue planning scope is invalid")
        for item in values.items:
            if item.stage_id != stage_id:
                raise ValueError("Plan items must target the active ready stage")
            self._validate_assignee(
                db,
                issue=issue,
                user_id=user_id,
                item=item,
            )
        self._supersede_items(db, run.id)
        for order, item in enumerate(values.items):
            db.add(
                ProjectWorkflowPlanItem(
                    cloud_project_id=issue.cloud_project_id,
                    parent_id=run.id,
                    title=item.title,
                    description=item.description,
                    status="proposed",
                    sort_order=order,
                    assignee_user_id=(
                        int(item.assignee_id)
                        if item.assignee_type == "user" and item.assignee_id
                        else None
                    ),
                    assignee_agent_id=(
                        item.assignee_id
                        if item.assignee_type == "agent" and item.assignee_id
                        else ""
                    ),
                    assignee_team_id=(
                        int(item.assignee_id)
                        if item.assignee_type == "team" and item.assignee_id
                        else None
                    ),
                    created_by_user_id=user_id,
                    updated_by_user_id=user_id,
                    metadata_json={
                        "client_key": item.client_key,
                        "stage_id": item.stage_id,
                        "assignee_type": item.assignee_type,
                        "assignee_id": item.assignee_id,
                        "assignee_name": item.assignee_name,
                        "rationale": item.rationale,
                        "depends_on": item.depends_on,
                    },
                )
            )
        run.description = values.summary
        run.status = "awaiting_approval"
        run.version += 1
        workflow.update(
            {
                "orchestration_status": "awaiting_approval",
                "active_run_id": run.id,
                "active_plan_version": self._plan_version(run),
                "current_stage_id": stage_id,
            }
        )
        self._write_workflow(issue, workflow)
        db.commit()
        db.refresh(run)
        return self._view(db, issue, run)

    def approve_plan(
        self, db: Session, *, issue_id: str, user_id: int
    ) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, BaseRole.Developer, for_update=True)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        if run is None:
            raise ValueError("The workflow plan is not awaiting approval")
        if run.status == "running":
            return self._view(db, issue, run)
        if run.status not in {"awaiting_approval", "dispatching"}:
            raise ValueError("The workflow plan is not awaiting approval")
        run.status = "dispatching"
        workflow["orchestration_status"] = "dispatching"
        self._write_workflow(issue, workflow)
        db.flush()
        owner = db.get(User, issue.created_by_user_id) or db.get(User, user_id)
        project = db.get(CloudProject, issue.cloud_project_id)
        if owner is None or project is None:
            raise ValueError("Workflow project or owner is unavailable")
        items = self._items(db, run.id)
        if not items:
            raise ValueError("Workflow plan has no items")
        if any(not self._assignee(item) for item in items):
            raise ValueError("Every workflow plan item needs an assignee")
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
                    parent_id=issue.id,
                    status="pending",
                    priority=issue.priority or "none",
                    **self._assignee_payload(item),
                ),
                commit=False,
                instruction=self._execution_instruction(item),
            )
            item.loop_item_id = child.id
            item.status = "materialized"
            item.version += 1
        stage_id = self._run_stage(run)
        self._set_stage_status(workflow, stage_id, "running", items)
        workflow["orchestration_status"] = "running"
        run.status = "running"
        run.version += 1
        self._write_workflow(issue, workflow)
        db.commit()
        db.refresh(run)
        return self._view(db, issue, run)

    def pause(
        self, db: Session, *, issue_id: str, user_id: int
    ) -> WorkflowPlanView | None:
        issue = self._issue(db, issue_id, user_id, BaseRole.Developer, for_update=True)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        workflow["orchestration_status"] = "paused"
        if run is not None and run.status not in {"completed", "failed"}:
            run.status = "paused"
            run.version += 1
        self._write_workflow(issue, workflow)
        db.commit()
        return self._view(db, issue, run) if run is not None else None

    def resume(self, db: Session, *, issue_id: str, user_id: int) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, BaseRole.Developer, for_update=True)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        if run is None:
            run = self._new_run(db, issue, workflow, user_id)
        elif run.status == "paused":
            items = self._items(db, run.id)
            run.status = (
                "running"
                if items and all(item.loop_item_id for item in items)
                else "awaiting_approval" if items else "planning"
            )
            if run.status == "running":
                self._set_stage_status(workflow, self._run_stage(run), "running", items)
            run.version += 1
        elif run.status == "failed":
            run = self._start_new_plan_version(
                db,
                issue=issue,
                workflow=workflow,
                user_id=user_id,
                current=run,
            )
        workflow["orchestration_status"] = run.status
        self._write_workflow(issue, workflow)
        db.commit()
        db.refresh(run)
        return self._view(db, issue, run)

    def dispatch_request(
        self, db: Session, *, issue_id: str, user_id: int
    ) -> WorkflowDispatchRequest:
        issue = self._issue(db, issue_id, user_id, BaseRole.Developer)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        automation_id = workflow.get("ai_automation_rule_id")
        if run is None or run.status != "planning":
            raise ValueError("AI workflow is not awaiting coordinator planning")
        if not isinstance(automation_id, str) or not automation_id:
            raise ValueError("AI workflow has no coordinator automation")
        return WorkflowDispatchRequest(
            plan=self._view(db, issue, run),
            project_id=str(issue.cloud_project_id),
            automation_id=automation_id,
            event_payload={
                "title": issue.title or "",
                "workflow": workflow,
            },
        )

    def fail_planning(
        self, db: Session, *, issue_id: str, user_id: int
    ) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, BaseRole.Developer, for_update=True)
        workflow = self._workflow(issue)
        run = self._active_run(db, issue, workflow)
        if run is None:
            raise ValueError("AI workflow no longer has an active plan")
        if run.status == "planning":
            run.status = "failed"
            run.version += 1
            workflow["orchestration_status"] = "failed"
            self._write_workflow(issue, workflow)
            db.commit()
            db.refresh(run)
        return self._view(db, issue, run)

    def replan(self, db: Session, *, issue_id: str, user_id: int) -> WorkflowPlanView:
        issue = self._issue(db, issue_id, user_id, BaseRole.Developer, for_update=True)
        workflow = self._workflow(issue)
        current = self._active_run(db, issue, workflow)
        run = self._start_new_plan_version(
            db,
            issue=issue,
            workflow=workflow,
            user_id=user_id,
            current=current,
        )
        db.commit()
        db.refresh(run)
        return self._view(db, issue, run)

    def report_task_outcome(
        self,
        db: Session,
        *,
        task_id: str,
        user_id: int,
        values: WorkflowTaskOutcomeSubmit,
    ) -> WorkflowOutcomeResult:
        child = self._issue(db, task_id, user_id, BaseRole.Developer)
        if not child.parent_id:
            raise ValueError("Task is not part of an AI-coordinated Issue")
        issue = self._issue(
            db,
            child.parent_id,
            user_id,
            BaseRole.Developer,
            for_update=True,
        )
        workflow = self._workflow(issue)
        if workflow.get("advancement_policy") != "ai":
            raise ValueError("Task is not part of an AI-coordinated Issue")
        reported_items = (
            db.query(ProjectWorkflowPlanItem)
            .filter(
                ProjectWorkflowPlanItem.loop_item_id == child.id,
                loop_datetime_is_unset(ProjectWorkflowPlanItem.deleted_at),
            )
            .all()
        )
        stored = next(
            (
                item
                for item in reported_items
                if isinstance((item.metadata_json or {}).get("outcome"), dict)
            ),
            None,
        )
        current = self._active_run(db, issue, workflow)
        if stored is not None:
            outcome = (stored.metadata_json or {}).get("outcome") or {}
            if outcome.get("verdict") != values.verdict:
                raise ValueError("Task outcome has already been reported")
            if current is None:
                raise ValueError("AI workflow no longer has an active plan")
            return self._outcome_result(
                db,
                issue=issue,
                workflow=workflow,
                run=current,
                replan_started=False,
                outcome=outcome,
                child=child,
            )
        if current is None or current.status != "running":
            raise ValueError("AI workflow is not accepting task outcomes")
        item = next(
            (
                candidate
                for candidate in self._items(db, current.id)
                if candidate.loop_item_id == child.id
            ),
            None,
        )
        if item is None:
            raise ValueError("Task does not belong to the active workflow plan")
        outcome = {
            **values.model_dump(),
            "task_id": child.id,
            "task_title": child.title or "",
        }
        item.metadata_json = {**(item.metadata_json or {}), "outcome": outcome}
        item.version += 1
        if values.verdict == "passed":
            db.commit()
            db.refresh(current)
            return self._outcome_result(
                db,
                issue=issue,
                workflow=workflow,
                run=current,
                replan_started=False,
                outcome=outcome,
                child=child,
            )
        run = self._start_new_plan_version(
            db,
            issue=issue,
            workflow=workflow,
            user_id=user_id,
            current=current,
            rework_context=outcome,
        )
        db.commit()
        db.refresh(run)
        return self._outcome_result(
            db,
            issue=issue,
            workflow=workflow,
            run=run,
            replan_started=True,
            outcome=outcome,
            child=child,
        )

    def sync_parent_for_child(self, db: Session, child: LoopItem) -> bool:
        if not child.parent_id:
            return False
        issue = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == child.parent_id,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
        if issue is None:
            return False
        workflow = self._workflow(issue, required=False)
        if not workflow or workflow.get("advancement_policy") != "ai":
            return False
        run = self._active_run(db, issue, workflow)
        if run is None or run.status != "running":
            return False
        items = self._items(db, run.id)
        task_ids = [item.loop_item_id for item in items if item.loop_item_id]
        if not task_ids:
            return False
        tasks = db.query(LoopItem).filter(LoopItem.id.in_(task_ids)).all()
        if not tasks or not all(task.status == "completed" for task in tasks):
            return False
        stage_id = self._run_stage(run)
        self._set_stage_status(workflow, stage_id, "completed", items)
        run.status = "completed"
        run.version += 1
        next_stage = (
            self._first_ready_stage(workflow)
            if self._uses_stage_dag(workflow)
            else None
        )
        if next_stage:
            self._new_run(db, issue, workflow, issue.created_by_user_id or 0)
            planning_started = True
        else:
            workflow["orchestration_status"] = "completed"
            workflow["active_run_id"] = None
            workflow["current_stage_id"] = None
            issue.status = "in_review"
            planning_started = False
        self._write_workflow(issue, workflow)
        return planning_started

    def _active_or_new_run(
        self, db: Session, issue: LoopItem, workflow: dict, user_id: int
    ) -> ProjectWorkflowRun:
        return self._active_run(db, issue, workflow) or self._new_run(
            db, issue, workflow, user_id
        )

    def _new_run(
        self,
        db: Session,
        issue: LoopItem,
        workflow: dict,
        user_id: int,
        *,
        previous: ProjectWorkflowRun | None = None,
    ) -> ProjectWorkflowRun:
        stage = self._planning_scope(issue, workflow)
        previous_version = max(
            int(workflow.get("active_plan_version") or 0),
            self._plan_version(previous),
        )
        run = ProjectWorkflowRun(
            cloud_project_id=issue.cloud_project_id,
            parent_id=issue.id,
            title=str(stage.get("name") or stage.get("id") or "Workflow stage"),
            status="planning",
            source="ai",
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            metadata_json={
                "stage_id": str(stage["id"]),
                "plan_version": previous_version + 1,
                "previous_run_id": previous.id if previous is not None else None,
            },
        )
        db.add(run)
        db.flush()
        workflow.update(
            {
                "orchestration_status": "planning",
                "active_run_id": run.id,
                "active_plan_version": previous_version + 1,
                "current_stage_id": (
                    str(stage["id"]) if self._uses_stage_dag(workflow) else None
                ),
            }
        )
        self._write_workflow(issue, workflow)
        return run

    def _start_new_plan_version(
        self,
        db: Session,
        *,
        issue: LoopItem,
        workflow: dict,
        user_id: int,
        current: ProjectWorkflowRun | None,
        rework_context: dict | None = None,
    ) -> ProjectWorkflowRun:
        if current is not None:
            items = self._items(db, current.id)
            self._set_stage_status(workflow, self._run_stage(current), "ready", items)
            current.status = "failed"
            current.metadata_json = {
                **(current.metadata_json or {}),
                "superseded": True,
                **(
                    {"rework_context": rework_context}
                    if rework_context is not None
                    else {}
                ),
            }
            current.version += 1
            self._supersede_items(db, current.id)
        run = self._new_run(db, issue, workflow, user_id, previous=current)
        if rework_context is not None:
            run.metadata_json = {
                **(run.metadata_json or {}),
                "rework_context": rework_context,
            }
        return run

    @staticmethod
    def _workflow(issue: LoopItem, *, required: bool = True) -> dict:
        metadata = dict(issue.metadata_json or {})
        workflow = metadata.get("workflow")
        if isinstance(workflow, dict):
            return dict(workflow)
        if required:
            raise ValueError("Issue has no workflow snapshot")
        return {}

    @staticmethod
    def _write_workflow(issue: LoopItem, workflow: dict) -> None:
        metadata = dict(issue.metadata_json or {})
        workflow["version"] = int(workflow.get("version") or 1) + 1
        metadata["workflow"] = workflow
        issue.metadata_json = metadata
        issue.version += 1

    @staticmethod
    def _first_ready_stage(workflow: dict) -> dict | None:
        return next(
            (
                node
                for node in workflow.get("nodes", [])
                if isinstance(node, dict) and node.get("status") == "ready"
            ),
            None,
        )

    @staticmethod
    def _uses_stage_dag(workflow: dict) -> bool:
        return workflow.get("stage_mode") == "dag"

    def _planning_scope(self, issue: LoopItem, workflow: dict) -> dict:
        if not self._uses_stage_dag(workflow):
            return {
                "id": ISSUE_WORKFLOW_SCOPE_ID,
                "name": issue.title or "Issue",
            }
        stage = self._first_ready_stage(workflow)
        if stage is None:
            raise ValueError("Issue workflow has no ready stage")
        return stage

    @staticmethod
    def _active_run(
        db: Session,
        issue: LoopItem,
        workflow: dict,
    ) -> ProjectWorkflowRun | None:
        run_id = workflow.get("active_run_id")
        if not isinstance(run_id, str):
            return None
        run = db.get(ProjectWorkflowRun, run_id)
        if run is None:
            raise ValueError("The active workflow run is unavailable")
        if run.parent_id != issue.id or str(run.cloud_project_id) != str(
            issue.cloud_project_id
        ):
            raise ValueError("The active workflow run does not belong to this Issue")
        return run

    @staticmethod
    def _run_stage(run: ProjectWorkflowRun) -> str:
        metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
        return str(metadata.get("stage_id") or "")

    @staticmethod
    def _plan_version(run: ProjectWorkflowRun | None) -> int:
        metadata = (
            run.metadata_json
            if run is not None and isinstance(run.metadata_json, dict)
            else {}
        )
        return int(metadata.get("plan_version") or 0)

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
    def _supersede_items(db: Session, run_id: str) -> None:
        for item in ProjectWorkflowOrchestrationService._items(db, run_id):
            item.status = "superseded"
            item.version += 1

    @staticmethod
    def _assignee(item: ProjectWorkflowPlanItem) -> tuple[str, str] | None:
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        kind = metadata.get("assignee_type")
        value = metadata.get("assignee_id")
        return (str(kind), str(value)) if kind and value else None

    @staticmethod
    def _assignee_payload(item: ProjectWorkflowPlanItem) -> dict:
        assignee = ProjectWorkflowOrchestrationService._assignee(item)
        if assignee is None:
            return {}
        kind, value = assignee
        if kind == "user":
            return {"assignee_user_id": int(value)}
        if kind == "agent":
            return {"assignee_agent_id": value}
        if kind == "team":
            return {"assignee_team_id": int(value)}
        raise ValueError("Unknown workflow plan assignee")

    @staticmethod
    def _execution_instruction(item: ProjectWorkflowPlanItem) -> str:
        base = item.description or ""
        assignee = ProjectWorkflowOrchestrationService._assignee(item)
        if assignee is None or assignee[0] == "user":
            return base
        outcome_instruction = (
            "如果该任务负责验证或测试前序工作，请在结束前调用 "
            "report_workflow_outcome：通过时上报 passed；发现需要返工的问题时"
            "上报 needs_rework，并提供摘要和 findings。"
        )
        return f"{base}\n\n{outcome_instruction}".strip()

    @staticmethod
    def _validate_assignee(
        db: Session,
        *,
        issue: LoopItem,
        user_id: int,
        item: WorkflowPlanItemCreate,
    ) -> None:
        if item.assignee_type is None or item.assignee_id is None:
            return
        if item.assignee_type == "user":
            member_ids = {
                str(member["user_id"])
                for member in cloud_project_service.list_members(
                    db, int(str(issue.cloud_project_id)), user_id
                )
            }
            if item.assignee_id not in member_ids:
                raise ValueError("Workflow plan selected an unavailable member")
        elif item.assignee_type == "agent":
            agent = db.get(ProjectChatAgent, item.assignee_id)
            if (
                agent is None
                or agent.cloud_project_id != issue.cloud_project_id
                or agent.status != "active"
            ):
                raise ValueError("Workflow plan selected an unavailable robot")
        else:
            runnable_wegent_team(db, user_id, int(item.assignee_id))

    @staticmethod
    def _set_stage_status(
        workflow: dict,
        stage_id: str,
        status: str,
        items: list[ProjectWorkflowPlanItem],
    ) -> None:
        if workflow.get("stage_mode") != "dag":
            return
        nodes = [dict(node) for node in workflow.get("nodes", [])]
        completed = {
            str(node.get("id"))
            for node in nodes
            if node.get("status") == "completed" and node.get("id")
        }
        if status == "completed":
            completed.add(stage_id)
        for node in nodes:
            if node.get("id") == stage_id:
                node["status"] = status
                node["task_ids"] = [
                    item.loop_item_id for item in items if item.loop_item_id
                ]
            elif node.get("status") == "blocked" and all(
                str(dependency) in completed
                for dependency in node.get("depends_on", [])
            ):
                node["status"] = "ready"
        workflow["nodes"] = nodes

    def _issue(
        self,
        db: Session,
        issue_id: str,
        user_id: int,
        role: BaseRole,
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
            raise ValueError("Issue is unavailable")
        require_cloud_project_role(db, int(str(issue.cloud_project_id)), user_id, role)
        return issue

    def _outcome_result(
        self,
        db: Session,
        *,
        issue: LoopItem,
        workflow: dict,
        run: ProjectWorkflowRun,
        replan_started: bool,
        outcome: dict,
        child: LoopItem,
    ) -> WorkflowOutcomeResult:
        automation_id = workflow.get("ai_automation_rule_id")
        return WorkflowOutcomeResult(
            plan=self._view(db, issue, run),
            replan_started=replan_started,
            project_id=str(issue.cloud_project_id),
            automation_id=(
                str(automation_id) if isinstance(automation_id, str) else None
            ),
            event_payload={
                "title": issue.title or "",
                "workflow": self._workflow(issue),
                "rework": outcome,
                "source_task": {
                    "id": child.id,
                    "title": child.title or "",
                },
            },
        )

    def _view(
        self,
        db: Session,
        issue: LoopItem,
        run: ProjectWorkflowRun,
    ) -> WorkflowPlanView:
        return WorkflowPlanView(
            run_id=run.id,
            issue_id=issue.id,
            stage_id=self._run_stage(run),
            plan_version=self._plan_version(run),
            status=run.status,
            summary=run.description or "",
            items=[
                WorkflowPlanItemView(
                    id=item.id,
                    client_key=str(
                        (item.metadata_json or {}).get("client_key") or item.id
                    ),
                    stage_id=str((item.metadata_json or {}).get("stage_id") or ""),
                    title=item.title or "",
                    description=item.description or "",
                    assignee_type=(item.metadata_json or {}).get("assignee_type"),
                    assignee_id=(item.metadata_json or {}).get("assignee_id"),
                    assignee_name=str(
                        (item.metadata_json or {}).get("assignee_name") or ""
                    ),
                    rationale=str((item.metadata_json or {}).get("rationale") or ""),
                    depends_on=list((item.metadata_json or {}).get("depends_on") or []),
                    task_id=item.loop_item_id or None,
                    status=item.status,
                )
                for item in self._items(db, run.id)
                if item.status != "superseded"
            ],
        )


project_workflow_orchestration_service = ProjectWorkflowOrchestrationService()


async def dispatch_workflow_replan(
    db: Session,
    *,
    result: WorkflowOutcomeResult,
    user_id: int,
) -> None:
    """Dispatch the configured coordinator exactly once for a new plan version."""

    if not result.replan_started or not result.automation_id:
        return
    from app.services.project_automations import (
        ProjectAutomationEvent,
        project_automation_processor,
    )

    dispatched = await project_automation_processor.process(
        db,
        ProjectAutomationEvent(
            event_type="workflow.replan",
            project_id=result.project_id,
            subject_id=result.plan.issue_id,
            source="workflow",
            actor_user_id=user_id,
            payload=result.event_payload,
        ),
        automation_id=result.automation_id,
    )
    if dispatched != 1:
        raise RuntimeError("The configured workflow coordinator was not dispatched")


async def dispatch_workflow_planning(
    db: Session,
    *,
    request: WorkflowDispatchRequest,
    user_id: int,
) -> None:
    """Dispatch a user-requested planning or recovery attempt."""

    from app.services.project_automations import (
        ProjectAutomationEvent,
        project_automation_processor,
    )

    dispatched = await project_automation_processor.process(
        db,
        ProjectAutomationEvent(
            event_type="workflow.replan",
            project_id=request.project_id,
            subject_id=request.plan.issue_id,
            source="workflow",
            actor_user_id=user_id,
            payload=request.event_payload,
        ),
        automation_id=request.automation_id,
    )
    if dispatched != 1:
        raise RuntimeError("The configured workflow coordinator was not dispatched")
