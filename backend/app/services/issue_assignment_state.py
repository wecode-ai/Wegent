# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Pure Issue assignment transitions, independent of storage and dispatch."""

from copy import deepcopy

from app.schemas.issue_assignment import IssueAssignmentDecision


def decide_assignment(workflow: dict, decision: IssueAssignmentDecision) -> dict:
    """Select work without treating reference-graph edges as execution gates."""
    current = workflow.get("assignment") or {}
    if workflow.get("migration_required"):
        raise ValueError("Choose an experience to continue this historical workflow")
    payload = decision.model_dump(mode="json")
    if current.get("id") == decision.request_id:
        if current.get("decision") != payload:
            raise ValueError("Assignment request ID was reused with different content")
        return workflow
    if workflow.get("advancement_policy") != "ai":
        raise ValueError("AI assignment requires AI advancement")
    if workflow.get("orchestration_status") == "completed":
        raise ValueError("The Issue automation is complete")
    if workflow.get("orchestration_status") == "paused":
        raise ValueError("The Issue automation is paused")
    if workflow.get("orchestration_status") == "waiting_human":
        raise ValueError("Wait for the assigned person to submit a result")
    if int(workflow.get("assignment_version") or 0) != decision.expected_version:
        raise ValueError("The Issue assignment changed; read it again")
    if current.get("status") in {"dispatching", "running"}:
        raise ValueError("The current assignment is still running")

    result = deepcopy(workflow)
    node = next(
        (node for node in result.get("nodes", []) if node["id"] == decision.node_id),
        None,
    )
    if decision.node_id and node is None:
        raise ValueError("The selected role is not in this Issue's experience")
    human_id = decision.assignee_user_id
    if decision.action == "assign_role" and node.get("execution_mode") == "human":
        human_id = node.get("assignee_user_id")
        if not human_id:
            raise ValueError("The selected human role has no assigned member")
    status = (
        "completed"
        if decision.action == "complete"
        else "waiting_human" if human_id else "dispatching"
    )
    result.update(
        current_stage_id=decision.node_id,
        current_work=decision.instruction,
        assignment_version=decision.expected_version + 1,
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
