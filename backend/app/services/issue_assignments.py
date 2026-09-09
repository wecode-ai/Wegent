# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Assign the existing Issue, persist its audit, and dispatch the selected role."""

from uuid import uuid4

from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectWorkflowRun
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.issue_assignment import IssueAssignmentDecision, IssueAssignmentResult
from app.schemas.issue_workflow import IssueWorkflowInstance
from app.services.cloud_projects.service import cloud_project_service
from app.services.issue_assignment_state import decide_assignment, finish_assignment
from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.loop_item_events import publish_loop_item_changed
from shared.telemetry.decorators import trace_async


def write_assignment(
    db: Session, issue: LoopItem, workflow: dict, content: str
) -> None:
    """Persist assignment state and its activity in the same transaction."""
    issue_workflow_planning_service._write_workflow(issue, workflow)
    db.add(
        ProjectChatMessage(
            message_id=str(uuid4()),
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
            return workflow
        if not manager_run_id:
            raise ValueError("Assignment requires the active AI coordinator")
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
            raise ValueError(str(exc)) from exc
        assignment = next_workflow["assignment"]
        next_workflow["coordinator_user_id"] = user_id
        member_id = assignment.get("assignee_user_id")
        if member_id:
            members = cloud_project_service.list_members(
                db, int(str(issue.cloud_project_id)), user_id
            )
            if member_id not in {int(member["user_id"]) for member in members}:
                raise ValueError("The assigned person is not a project member")
        elif decision.action != "complete":
            snapshot = IssueWorkflowInstance.model_validate(next_workflow)
            node = next((n for n in snapshot.nodes if n.id == decision.node_id), None)
            config = (
                snapshot.execution_config_for(node)
                if node
                else snapshot.execution_config
            )
            if config is None or not config.is_complete():
                raise ValueError("The assigned role needs execution configuration")
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
        return issue_workflow_planning_service._workflow(issue)

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
