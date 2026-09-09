# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Assign the existing Issue, persist its audit, and dispatch the selected role."""

from uuid import uuid4

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRun,
    ProjectWorkflowRun,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.issue_assignment import IssueAssignmentDecision, IssueAssignmentResult
from app.schemas.issue_workflow import IssueWorkflowInstance
from app.services.cloud_projects.service import cloud_project_service
from app.services.issue_assignment_errors import IssueAssignmentConflict
from app.services.issue_assignment_state import decide_assignment, finish_assignment
from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.loop_item_events import publish_loop_item_changed
from shared.telemetry.decorators import trace_async


def write_assignment(
    db: Session, issue: LoopItem, workflow: dict, content: str
) -> None:
    """Persist assignment state and its activity in the same transaction."""
    issue_workflow_planning_service._write_workflow(issue, workflow)
    message_id = str(uuid4())
    db.add(
        ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=str(issue.cloud_project_id),
            task_id=str(issue.id),
            sender_type="system",
            sender_id="issue_assignment",
            sender_name="AI",
            message_type="text",
            content=content,
            metadata_json={"issue_assignment": workflow.get("assignment")},
            status="completed",
        )
    )


def assignment_handoff(workflow: dict) -> dict:
    """Acknowledge a durable decision and release the coordinator turn."""
    status = workflow.get("orchestration_status")
    resume_on: str | None
    if status == "completed":
        resume_on = None
        instruction = "The Issue is complete. End this turn."
    elif status == "waiting_human":
        resume_on = "human_continue"
        instruction = (
            "The assigned person now controls advancement. End this turn. "
            "Only that person's explicit Continue action submits their result "
            "and resumes coordination. Comments, notifications, external events, "
            "and completion of tasks they start are not approval to advance. "
            "Do not submit a human result on their behalf."
        )
    else:
        resume_on = "assignment_result_callback"
        instruction = (
            "The backend owns this assignment. End this turn now; do not "
            "sleep, poll, or wait for the worker. A result callback will start "
            "your next coordinator turn with the success or failure result."
        )
    return {
        **workflow,
        "coordinator_handoff": {
            "end_turn": True,
            "resume_on": resume_on,
            "instruction": instruction,
        },
    }


def assignment_callback_intent(
    db: Session, execution: LoopItemExecution, status: str
) -> dict | None:
    """Resume accepted assignment results even when work has no graph node."""
    if status not in {"succeeded", "failed"}:
        return None
    issue = db.get(LoopItem, execution.loop_item_id)
    workflow = (issue.metadata_json or {}).get("workflow", {}) if issue else {}
    assignment = workflow.get("assignment") or {}
    run_id = assignment.get("automation_run_id")
    if (
        workflow.get("advancement_policy") != "ai"
        or workflow.get("orchestration_status") != "planning"
        or assignment.get("status") != "completed"
        or not run_id
        or str(run_id) != str(execution.automation_run_id)
    ):
        return None
    return {
        "item_id": issue.id,
        "user_id": int(
            workflow.get("coordinator_user_id") or execution.executor_owner_user_id
        ),
        "stage_ids": [],
    }


def pause_assignment_for_user_stop(db: Session, run_id: str | None) -> None:
    """Persist stop intent before contacting Runtime; only affect the current work."""
    if not run_id:
        return
    run = db.get(ProjectAutomationRun, run_id)
    if run is None or not run.task_id:
        return
    issue = (
        db.query(LoopItem)
        .filter(LoopItem.id == run.task_id)
        .populate_existing()
        .with_for_update()
        .first()
    )
    if issue is None:
        return
    workflow = dict((issue.metadata_json or {}).get("workflow") or {})
    if workflow.get("advancement_policy") != "ai" or workflow.get(
        "orchestration_status"
    ) in {"paused", "completed"}:
        return
    assignment = workflow.get("assignment") or {}
    payload = ((run.metadata_json or {}).get("event") or {}).get("payload") or {}
    current_worker = str(assignment.get("automation_run_id") or "") == str(run.id)
    current_coordinator = (
        workflow.get("orchestration_status") == "planning"
        and workflow.get("active_run_id") is not None
        and str(payload.get("workflow_run_id") or "") == str(workflow["active_run_id"])
    )
    if not current_worker and not current_coordinator:
        return
    workflow["orchestration_status"] = "paused"
    write_assignment(
        db, issue, workflow, "用户已停止当前执行，自动调度已暂停；恢复后继续。"
    )
    db.flush()


class IssueAssignmentService:
    @trace_async()
    async def decide(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
        decision: IssueAssignmentDecision,
        manager_run_id: str,
    ) -> dict:
        from app.services.project_automation_execution import (
            project_automation_execution,
        )
        from app.services.project_automations import project_automation_service

        issue = issue_workflow_planning_service._issue(
            db, issue_id, user_id, for_update=True
        )
        workflow = issue_workflow_planning_service._workflow(issue)
        next_workflow = decide_assignment(workflow, decision)
        if next_workflow is workflow:
            return assignment_handoff(workflow)
        if not manager_run_id:
            raise IssueAssignmentConflict(
                "coordinator_invalid", "Assignment requires the active AI coordinator"
            )
        run_id = workflow.get("active_run_id")
        try:
            project_automation_execution.record_manager_plan_submission(
                db,
                run_id=manager_run_id,
                user_id=user_id,
                workflow_run_id=run_id,
                plan_version=int(workflow.get("active_plan_version") or 1),
                commit=False,
            )
        except RuntimeError as exc:
            raise IssueAssignmentConflict("coordinator_invalid", str(exc)) from exc
        assignment = next_workflow["assignment"]
        next_workflow["coordinator_user_id"] = user_id
        member_id = assignment.get("assignee_user_id")
        if member_id:
            members = cloud_project_service.list_members(
                db, int(str(issue.cloud_project_id)), user_id
            )
            if member_id not in {int(member["user_id"]) for member in members}:
                raise IssueAssignmentConflict(
                    "assignee_not_member", "The assigned person is not a project member"
                )
        elif decision.action != "complete":
            snapshot = IssueWorkflowInstance.model_validate(next_workflow)
            node = next((n for n in snapshot.nodes if n.id == decision.node_id), None)
            config = (
                snapshot.execution_config_for(node)
                if node
                else snapshot.execution_config
            )
            if config is None or not config.is_complete():
                raise IssueAssignmentConflict(
                    "execution_config_required",
                    "The assigned role needs execution configuration",
                )
        issue.assignee_user_id = member_id or None
        issue.assignee_agent_id = ""
        issue.assignee_team_id = None
        issue.status = "completed" if decision.action == "complete" else "in_progress"
        role = next(
            (
                n["name"]
                for n in workflow.get("nodes", [])
                if n["id"] == decision.node_id
            ),
            "",
        )
        write_assignment(
            db,
            issue,
            next_workflow,
            "\n\n".join(
                filter(
                    None,
                    [
                        role,
                        decision.instruction,
                        decision.reason,
                    ],
                )
            ),
        )
        planning_run = db.get(ProjectWorkflowRun, run_id)
        if planning_run:
            planning_run.status = "completed"
        db.flush()
        if assignment["status"] == "dispatching":
            await project_automation_service.run_direct_workflow_node(
                db,
                str(issue.cloud_project_id),
                str(issue.id),
                decision.node_id,
                user_id,
            )
        if decision.action == "complete":
            from app.services.project_workflow_projection import (
                sync_workflow_automation_status,
            )

            sync_workflow_automation_status(db, issue, run_status="succeeded")
        db.commit()
        publish_loop_item_changed(
            db, item=issue, reason="issue_assigned", actor_user_id=user_id
        )
        return assignment_handoff(issue_workflow_planning_service._workflow(issue))

    @trace_async()
    async def submit_result(
        self,
        db: Session,
        *,
        issue_id: str,
        user_id: int,
        result: IssueAssignmentResult,
    ) -> dict:
        from app.services.issue_workflow_start import issue_workflow_start_service

        issue = issue_workflow_planning_service._issue(
            db, issue_id, user_id, for_update=True
        )
        workflow = issue_workflow_planning_service._workflow(issue)
        assignment = workflow.get("assignment") or {}
        if assignment.get("assignee_user_id") != user_id:
            raise ValueError("Only the assigned person can submit this result")
        next_workflow = finish_assignment(
            workflow, result.assignment_id, result.summary
        )
        if next_workflow is workflow:
            return workflow
        write_assignment(db, issue, next_workflow, result.summary)
        if workflow.get("advancement_policy") == "manual":
            from app.services.project_workflow_projection import apply_workflow_nodes

            apply_workflow_nodes(
                db,
                issue,
                workflow=next_workflow,
                nodes=next_workflow["nodes"],
                actor_user_id=user_id,
            )
        issue.assignee_user_id = None
        db.commit()
        project = db.get(CloudProject, issue.cloud_project_id)
        await issue_workflow_start_service.start(
            db,
            item=issue,
            project=project,
            user_id=int(workflow.get("coordinator_user_id") or user_id),
        )
        publish_loop_item_changed(
            db, item=issue, reason="issue_assignment_result", actor_user_id=user_id
        )
        return issue_workflow_planning_service._workflow(issue)


issue_assignment_service = IssueAssignmentService()
