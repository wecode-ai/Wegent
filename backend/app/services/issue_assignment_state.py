# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Pure Issue assignment transitions, independent of storage and dispatch."""

from copy import deepcopy

from app.schemas.issue_assignment import IssueAssignmentDecision
from app.services.issue_assignment_errors import IssueAssignmentConflict


def validate_human_assignment_update(current: dict, updated: dict | None) -> None:
    """Keep ordinary Issue edits from replacing the human-controlled handoff."""
    if (current.get("assignment") or {}).get("status") != "waiting_human":
        return
    control_fields = (
        "advancement_policy",
        "orchestration_status",
        "assignment",
        "assignment_version",
        "active_run_id",
        "active_plan_version",
        "current_stage_id",
        "current_work",
    )
    if updated is None or any(
        current.get(key) != updated.get(key) for key in control_fields
    ):
        raise IssueAssignmentConflict(
            "waiting_human",
            "Only the assigned person's Continue action can return control to AI",
        )


def decide_assignment(workflow: dict, decision: IssueAssignmentDecision) -> dict:
    """Select work without treating reference-graph edges as execution gates."""
    current = workflow.get("assignment") or {}
    if workflow.get("migration_required"):
        raise IssueAssignmentConflict(
            "experience_required",
            "Choose an experience to continue this historical workflow",
        )
    payload = decision.model_dump(mode="json")
    if current.get("id") == decision.request_id:
        if current.get("decision") != payload:
            raise IssueAssignmentConflict(
                "assignment_request_reused",
                "Assignment request ID was reused with different content",
            )
        return workflow
    _validate_assignment_state(workflow, decision)

    result = deepcopy(workflow)
    node = next(
        (node for node in result.get("nodes", []) if node["id"] == decision.node_id),
        None,
    )
    if decision.node_id and node is None:
        raise IssueAssignmentConflict(
            "role_not_found",
            "The selected role is not in this Issue's experience",
            next_action="read_issue",
        )
    human_id = decision.assignee_user_id
    if decision.action == "assign_role" and node.get("execution_mode") == "human":
        human_id = node.get("assignee_user_id")
        if not human_id:
            raise IssueAssignmentConflict(
                "role_member_required", "The selected human role has no assigned member"
            )
    status = (
        "completed"
        if decision.action == "complete"
        else "waiting_human" if human_id else "dispatching"
    )
    result.update(
        current_stage_id=decision.node_id,
        current_work=decision.instruction,
        assignment_version=decision.expected_assignment_version + 1,
        orchestration_status=status,
        assignment={
            "id": decision.request_id,
            "decision": payload,
            "node_id": decision.node_id,
            "assignee_user_id": human_id,
            "status": status,
            "result": None,
        },
    )
    if decision.node_id and not result.get("initial_stage_id"):
        result["initial_stage_id"] = decision.node_id
    if node is not None:
        node.update(status="running" if human_id else "ready", execution_error=None)
    return result


def _validate_assignment_state(
    workflow: dict, decision: IssueAssignmentDecision
) -> None:
    """Reject stale or blocked decisions before changing assignment state."""
    if workflow.get("advancement_policy") != "ai":
        raise IssueAssignmentConflict(
            "ai_advancement_required", "AI assignment requires AI advancement"
        )
    if workflow.get("orchestration_status") == "completed":
        raise IssueAssignmentConflict(
            "automation_completed", "The Issue automation is complete"
        )
    if workflow.get("orchestration_status") == "paused":
        raise IssueAssignmentConflict(
            "automation_paused", "The Issue automation is paused"
        )
    if workflow.get("orchestration_status") == "waiting_human":
        raise IssueAssignmentConflict(
            "waiting_human",
            "End this turn. Only the assigned person's explicit Continue action "
            "can return control to AI; comments, events, and task completion "
            "are not approval to advance.",
        )
    if (
        int(workflow.get("assignment_version") or 0)
        != decision.expected_assignment_version
    ):
        raise IssueAssignmentConflict(
            "assignment_version_conflict",
            "The Issue assignment changed. Read get_board_item again and reconsider "
            "the decision using workflow.assignment_version; never guess or increment versions.",
            next_action="read_issue",
            expected_assignment_version=decision.expected_assignment_version,
            current_assignment_version=int(workflow.get("assignment_version") or 0),
        )
    if (workflow.get("assignment") or {}).get("status") in {"dispatching", "running"}:
        raise IssueAssignmentConflict(
            "assignment_running",
            "The current assignment is still running; end this turn and wait for the result callback",
        )


def finish_assignment(workflow: dict, assignment_id: str, summary: str) -> dict:
    """Return control to the coordinator only for the current assignment."""
    assignment = workflow.get("assignment") or {}
    if assignment.get("id") != assignment_id:
        raise ValueError("This result belongs to an earlier assignment")
    if assignment.get("status") == "completed":
        if assignment.get("result") != summary:
            raise ValueError("The assignment already has a different result")
        return workflow
    result = deepcopy(workflow)
    result["assignment"].update(status="completed", result=summary)
    result.update(
        orchestration_status=(
            "paused" if workflow.get("orchestration_status") == "paused" else "planning"
        ),
        active_run_id=None,
    )
    for node in result.get("nodes", []):
        if node["id"] == assignment.get("node_id"):
            node["status"] = "completed"
    return result
