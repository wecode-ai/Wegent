# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project trusted task and automation states onto one Issue workflow."""

import logging
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectAutomationRun,
    ProjectWorkflowRun,
    loop_datetime_is_unset,
    loop_unset_datetime_for_connection,
)
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.issue_workflow import (
    IssueWorkflowInstance,
    WorkflowNodeInstance,
    workflow_node_execution_mode,
)
from app.services.loop_item_status_history import later_project_status
from app.services.loop_item_unread import advance_content_revision
from app.services.project_automation_domain import utcnow

COMPLETED_NODE_STATUSES = {"completed", "forced_completed"}
SUCCESS_TASK_STATUSES = {"succeeded", "archived"}
FAILED_TASK_STATUSES = {"failed", "cancelled"}
TERMINAL_AUTOMATION_RUN_STATUSES = {"succeeded", "failed", "skipped", "cancelled"}
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _WorkflowNodeState:
    node: WorkflowNodeInstance
    status: str
    child_run: ProjectAutomationRun | None
    child_status: str
    error: str


def _workflow_node_states(
    db: Session,
    nodes: list[WorkflowNodeInstance],
) -> list[_WorkflowNodeState]:
    run_ids = {str(node.automation_run_id) for node in nodes if node.automation_run_id}
    runs = (
        db.query(ProjectAutomationRun)
        .filter(ProjectAutomationRun.id.in_(run_ids))
        .all()
        if run_ids
        else []
    )
    latest_execution_ids = (
        db.query(func.max(LoopItemExecution.id))
        .filter(LoopItemExecution.automation_run_id.in_(run_ids))
        .group_by(LoopItemExecution.automation_run_id)
        .all()
        if run_ids
        else []
    )
    executions = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.id.in_(
                [execution_id for (execution_id,) in latest_execution_ids]
            )
        )
        .all()
        if latest_execution_ids
        else []
    )
    runs_by_id = {str(run.id): run for run in runs}
    executions_by_run_id = {
        str(execution.automation_run_id): execution for execution in executions
    }
    from app.services.loop_item_executions.service import execution_display_state

    states: list[_WorkflowNodeState] = []
    for node in nodes:
        run_id = str(node.automation_run_id or "")
        child_run = runs_by_id.get(run_id)
        execution = executions_by_run_id.get(run_id)
        child_status = (
            execution_display_state(execution)
            if execution is not None
            else str(child_run.status) if child_run is not None else ""
        )
        node_status = node.status
        if child_status in {"succeeded", "skipped"}:
            node_status = "completed"
        elif child_status in {"failed", "cancelled"}:
            node_status = "failed"
        states.append(
            _WorkflowNodeState(
                node=node,
                status=node_status,
                child_run=child_run,
                child_status=child_status,
                error=(
                    execution.error_message or execution.execution_note or ""
                    if execution is not None
                    else ""
                ),
            )
        )
    return states


def _project_task_status(
    db: Session,
    node: dict,
    *,
    task_statuses: dict[str, str],
    ordered_task_ids: list[str],
) -> str:
    if any(task_statuses.get(task_id) == "running" for task_id in ordered_task_ids):
        return "running"
    latest_status = task_statuses.get(ordered_task_ids[0]) if ordered_task_ids else None
    if latest_status in SUCCESS_TASK_STATUSES:
        if workflow_node_execution_mode(node) == "human":
            return "awaiting_approval"
        from app.services.workflow_deliverables import missing_requirement_ids

        return (
            "awaiting_deliverables"
            if missing_requirement_ids(db, node)
            else "completed"
        )
    if latest_status in FAILED_TASK_STATUSES:
        return "failed"
    return str(node.get("status") or "ready")


def reconcile_workflow_task_nodes(
    db: Session,
    nodes: list[dict],
    bindings: list[LoopItemTaskBinding],
) -> list[dict]:
    task_ids_by_node: dict[str, list[str]] = {}
    for binding in bindings:
        node_id = binding.workflow_node_id
        if not node_id or not binding.device_id or not binding.task_id:
            continue
        task_ids_by_node.setdefault(node_id, []).append(
            f"{binding.device_id}:{binding.task_id}"
        )

    reconciled: list[dict] = []
    for raw_node in nodes:
        node = dict(raw_node)
        if node.get("status") in COMPLETED_NODE_STATUSES | {"awaiting_deliverables"}:
            reconciled.append(node)
            continue
        task_statuses = node.get("task_statuses")
        if not isinstance(task_statuses, dict):
            reconciled.append(node)
            continue
        ordered_task_ids = list(
            dict.fromkeys(
                [
                    *task_ids_by_node.get(str(node.get("id")), []),
                    *(node.get("task_ids") or []),
                ]
            )
        )
        if not any(task_id in task_statuses for task_id in ordered_task_ids):
            reconciled.append(node)
            continue
        node["status"] = _project_task_status(
            db,
            node,
            task_statuses=task_statuses,
            ordered_task_ids=ordered_task_ids,
        )
        node["task_ids"] = ordered_task_ids
        reconciled.append(node)
    return reconciled


def update_workflow_task_status(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    task_id: str,
    execution_status: str,
) -> LoopItem | None:
    logger.info(
        "[IssueTaskStatusSync] update received user=%s device=%s task=%s status=%s",
        user_id,
        device_id,
        task_id,
        execution_status,
    )
    binding = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.task_user_id == user_id,
            LoopItemTaskBinding.device_id == device_id,
            LoopItemTaskBinding.task_id == task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .first()
    )
    if binding is None:
        logger.warning(
            "[IssueTaskStatusSync] binding missing user=%s device=%s task=%s",
            user_id,
            device_id,
            task_id,
        )
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud context not found")
    if not binding.loop_item_id or not binding.workflow_node_id:
        logger.info(
            "[IssueTaskStatusSync] binding has no workflow target binding=%s "
            "loop_item=%s workflow_node=%s",
            binding.id,
            binding.loop_item_id,
            binding.workflow_node_id,
        )
        return None

    item = (
        db.query(LoopItem)
        .filter(LoopItem.id == binding.loop_item_id)
        .with_for_update()
        .first()
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
    metadata = dict(item.metadata_json or {})
    workflow = metadata.get("workflow")
    raw_nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if not isinstance(raw_nodes, list):
        raise HTTPException(status.HTTP_409_CONFLICT, "Issue has no workflow")

    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.loop_item_id == item.id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .order_by(
            LoopItemTaskBinding.linked_at.desc(),
            LoopItemTaskBinding.id.desc(),
        )
        .all()
    )
    bindings = [
        candidate
        for candidate in bindings
        if candidate.workflow_node_id == binding.workflow_node_id
    ]
    runtime_task_id = f"{device_id}:{task_id}"
    changed = False
    nodes: list[dict] = []
    for raw_node in raw_nodes:
        node = dict(raw_node) if isinstance(raw_node, dict) else {}
        if node.get("id") == binding.workflow_node_id:
            task_statuses = dict(node.get("task_statuses") or {})
            previous_status = task_statuses.get(runtime_task_id)
            if task_statuses.get(runtime_task_id) != execution_status:
                task_statuses[runtime_task_id] = execution_status
                changed = True
            ordered_task_ids = list(
                dict.fromkeys(
                    [
                        *[
                            f"{candidate.device_id}:{candidate.task_id}"
                            for candidate in bindings
                            if candidate.device_id and candidate.task_id
                        ],
                        *(node.get("task_ids") or []),
                        runtime_task_id,
                    ]
                )
            )
            node_status = _project_task_status(
                db,
                node,
                task_statuses=task_statuses,
                ordered_task_ids=ordered_task_ids,
            )
            if (
                node.get("status") != node_status
                or node.get("task_ids") != ordered_task_ids
            ):
                changed = True
            node["status"] = node_status
            node["task_ids"] = ordered_task_ids
            node["task_statuses"] = task_statuses
            logger.info(
                "[IssueTaskStatusSync] workflow task projected item=%s node=%s "
                "runtime_task=%s previous=%s next=%s node_status=%s",
                item.id,
                binding.workflow_node_id,
                runtime_task_id,
                previous_status,
                execution_status,
                node_status,
            )
        nodes.append(node)
    if not changed:
        return item
    return apply_workflow_nodes(db, item, workflow=workflow, nodes=nodes)


def apply_workflow_nodes(
    db: Session,
    item: LoopItem,
    *,
    workflow: dict,
    nodes: list[dict],
    actor_user_id: int | None = None,
) -> LoopItem:
    completed = {
        str(node.get("id"))
        for node in nodes
        if node.get("status") in COMPLETED_NODE_STATUSES and node.get("id")
    }
    for node in nodes:
        dependencies = node.get("depends_on")
        dependencies = dependencies if isinstance(dependencies, list) else []
        if node.get("status") == "blocked" and all(
            str(dependency) in completed for dependency in dependencies
        ):
            node["status"] = "ready"

    next_workflow = dict(workflow)
    next_workflow["version"] = int(workflow.get("version") or 1) + 1
    next_workflow["nodes"] = nodes
    metadata = dict(item.metadata_json or {})
    metadata["workflow"] = next_workflow
    item.metadata_json = advance_content_revision(metadata, actor_user_id=actor_user_id)
    required = [node for node in nodes if node.get("required", True)]
    if required and all(
        node.get("status") in COMPLETED_NODE_STATUSES for node in required
    ):
        projected_status = "in_review"
    elif any(node.get("status") in {"running", "changes_requested"} for node in nodes):
        projected_status = "in_progress"
    else:
        projected_status = "pending"
    project = db.get(CloudProject, item.cloud_project_id)
    if project is None:
        raise RuntimeError("Workflow project is unavailable")
    item.status = later_project_status(
        project,
        current_status=item.status,
        candidate_status=projected_status,
    )
    item.version += 1
    sync_workflow_automation_nodes(db, item, nodes)
    return item


def sync_workflow_automation_nodes(
    db: Session,
    item: LoopItem,
    nodes: list[dict],
) -> None:
    next_status, next_description = workflow_automation_run_state(db, item, nodes)
    sync_workflow_automation_status(
        db,
        item,
        run_status=next_status,
        description=next_description,
    )


def workflow_automation_run_state(
    db: Session,
    item: LoopItem,
    nodes: list[dict],
) -> tuple[str, str]:
    """Derive one root automation state from its workflow execution chain."""

    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    raw_workflow = metadata.get("workflow")
    if not isinstance(raw_workflow, dict):
        raise RuntimeError("Workflow automation Issue has no workflow snapshot")
    workflow = IssueWorkflowInstance.model_validate({**raw_workflow, "nodes": nodes})
    required = [node for node in workflow.nodes if node.required]
    if not required:
        return "succeeded", ""

    states = _workflow_node_states(db, required)
    failed = next((state for state in states if state.status == "failed"), None)
    if failed is not None:
        error = (
            failed.error
            or (
                failed.child_run.description
                if failed.child_run is not None and failed.child_run.description
                else ""
            )
            or failed.node.execution_error
            or "Workflow node failed"
        )
        return "failed", str(error)
    if all(state.status in COMPLETED_NODE_STATUSES for state in states):
        return "succeeded", ""

    active_statuses = {
        state.child_status
        for state in states
        if state.child_status
        and state.child_status not in TERMINAL_AUTOMATION_RUN_STATUSES
    }
    if "running" in active_statuses:
        return "running", ""
    if any(
        state.node.status in {"blocked", "ready", "failed"}
        and workflow.node_needs_execution_config(state.node)
        for state in states
    ):
        return "waiting_runtime", ""
    if "waiting_runtime" in active_statuses:
        return "waiting_runtime", ""
    if "waiting_device" in active_statuses:
        return "waiting_device", ""
    if "queued" in active_statuses:
        return "queued", ""
    if "pending" in active_statuses:
        return "pending", ""
    if any(
        state.status
        in {
            "running",
            "awaiting_approval",
            "awaiting_deliverables",
            "changes_requested",
        }
        for state in states
    ):
        return "running", ""
    if any(state.status == "queued" for state in states):
        return "queued", ""
    if any(
        state.status == "ready" and state.node.execution_mode == "robot"
        for state in states
    ):
        return "pending", ""
    return "running", ""


def sync_workflow_automation_status(
    db: Session,
    item: LoopItem,
    *,
    run_status: str,
    description: str = "",
) -> None:
    """Project one Issue workflow state onto its owning automation run."""

    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    binding = metadata.get("workflow_automation")
    run_id = binding.get("run_id") if isinstance(binding, dict) else None
    if not isinstance(run_id, str) or not run_id:
        return
    run = db.get(ProjectAutomationRun, run_id)
    if run is None or str(run.task_id or "") != str(item.id):
        return
    next_status = (
        run_status
        if run_status
        in {
            "pending",
            "queued",
            "waiting_runtime",
            "waiting_device",
            "running",
            "succeeded",
            "failed",
            "skipped",
            "cancelled",
        }
        else "running"
    )
    next_description = description[:2000] if next_status == "failed" else ""
    if run.status == next_status and (run.description or "") == next_description:
        return
    run.status = next_status
    run.description = next_description
    run.completed_at = (
        utcnow()
        if next_status in {"succeeded", "failed"}
        else loop_unset_datetime_for_connection(db.connection(), "completed_at")
    )
    run.version += 1


def reconcile_workflow_automation_run(
    db: Session,
    run: ProjectAutomationRun,
) -> bool:
    """Repair an active root run from its bound workflow snapshot."""

    if run.status in TERMINAL_AUTOMATION_RUN_STATUSES or not run.task_id:
        return False
    item = db.get(LoopItem, str(run.task_id))
    if item is None:
        return False
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    binding = metadata.get("workflow_automation")
    if not isinstance(binding, dict) or str(binding.get("run_id") or "") != str(run.id):
        return False
    workflow = metadata.get("workflow")
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if not isinstance(nodes, list):
        return False
    normalized_nodes = [dict(node) for node in nodes if isinstance(node, dict)]
    before = (run.status, run.description, run.completed_at, run.version)
    sync_workflow_automation_nodes(db, item, normalized_nodes)
    return before != (run.status, run.description, run.completed_at, run.version)


def update_workflow_node(
    db: Session,
    *,
    item_id: str,
    node_id: str,
    node_status: str,
    automation_run_id: str | None = None,
    execution_error: str | None = None,
) -> LoopItem | None:
    item = db.query(LoopItem).filter(LoopItem.id == item_id).with_for_update().first()
    if item is None:
        return None
    metadata = dict(item.metadata_json or {})
    workflow = metadata.get("workflow")
    if not isinstance(workflow, dict):
        return item
    raw_nodes = workflow.get("nodes")
    if not isinstance(raw_nodes, list):
        return item

    changed = False
    nodes: list[dict] = []
    for raw_node in raw_nodes:
        node = dict(raw_node) if isinstance(raw_node, dict) else {}
        if node.get("id") == node_id:
            if node.get("status") != node_status:
                node["status"] = node_status
                changed = True
            if automation_run_id and node.get("automation_run_id") != automation_run_id:
                node["automation_run_id"] = automation_run_id
                changed = True
            if execution_error:
                normalized_error = execution_error[:2000]
                if node.get("execution_error") != normalized_error:
                    node["execution_error"] = normalized_error
                    changed = True
            elif "execution_error" in node:
                node.pop("execution_error")
                changed = True
        nodes.append(node)

    if not changed:
        return item
    return apply_workflow_nodes(db, item, workflow=workflow, nodes=nodes)


def sync_automation_workflow_node(
    db: Session, run: ProjectAutomationRun
) -> LoopItem | None:
    metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
    node_id = metadata.get("workflow_node_id")
    if not isinstance(node_id, str) or not node_id:
        return _sync_ai_planning_run(db, run, metadata)
    if not run.task_id:
        return None
    status_map = {
        "pending": "queued",
        "queued": "queued",
        "waiting_runtime": "queued",
        "waiting_device": "queued",
        "running": "running",
        "succeeded": "completed",
        "skipped": "completed",
        "failed": "failed",
        "cancelled": "failed",
    }
    node_status = status_map.get(run.status)
    if node_status is None:
        return None
    if node_status == "completed":
        item = db.get(LoopItem, str(run.task_id))
        metadata_json = (
            item.metadata_json
            if item is not None and isinstance(item.metadata_json, dict)
            else {}
        )
        workflow = metadata_json.get("workflow")
        nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        node = next(
            (
                candidate
                for candidate in nodes or []
                if isinstance(candidate, dict) and candidate.get("id") == node_id
            ),
            None,
        )
        if node is not None:
            from app.services.workflow_deliverables import missing_requirement_ids

            if missing_requirement_ids(db, node):
                node_status = "awaiting_deliverables"
    return update_workflow_node(
        db,
        item_id=str(run.task_id),
        node_id=node_id,
        node_status=node_status,
        automation_run_id=str(run.id),
        execution_error=run.description if node_status == "failed" else None,
    )


def _sync_ai_planning_run(
    db: Session,
    run: ProjectAutomationRun,
    metadata: dict,
) -> LoopItem | None:
    event = metadata.get("event")
    payload = event.get("payload") if isinstance(event, dict) else None
    workflow_run_id = (
        str(payload.get("workflow_run_id") or "") if isinstance(payload, dict) else ""
    )
    if not workflow_run_id or not run.task_id:
        return None
    workflow_run = db.get(ProjectWorkflowRun, workflow_run_id)
    issue = db.get(LoopItem, str(run.task_id))
    if workflow_run is None or issue is None or workflow_run.parent_id != issue.id:
        return None
    issue_metadata = (
        dict(issue.metadata_json) if isinstance(issue.metadata_json, dict) else {}
    )
    workflow = issue_metadata.get("workflow")
    if (
        not isinstance(workflow, dict)
        or workflow.get("active_run_id") != workflow_run.id
        or workflow_run.status != "planning"
    ):
        return issue
    if run.status not in {"failed", "cancelled", "skipped"}:
        return issue
    workflow_run.status = "failed"
    workflow_run.description = run.description or "AI manager did not submit a plan"
    workflow_run.version += 1
    next_workflow = dict(workflow)
    next_workflow["version"] = int(workflow.get("version") or 1) + 1
    next_workflow["orchestration_status"] = "failed"
    issue_metadata["workflow"] = next_workflow
    issue.metadata_json = issue_metadata
    issue.version += 1
    sync_workflow_automation_status(
        db,
        issue,
        run_status="failed",
        description=workflow_run.description,
    )
    return issue
