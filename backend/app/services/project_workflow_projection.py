# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project trusted task and automation states onto one Issue workflow."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectAutomationRun, ProjectWorkflowRun


def _sync_coordinator_failure(
    db: Session,
    run: ProjectAutomationRun,
) -> LoopItem | None:
    if (
        run.status not in {"succeeded", "failed", "cancelled", "skipped"}
        or not run.task_id
    ):
        return None
    run_metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
    event = run_metadata.get("event")
    payload = event.get("payload") if isinstance(event, dict) else None
    workflow_payload = payload.get("workflow") if isinstance(payload, dict) else None
    if (
        not isinstance(workflow_payload, dict)
        or workflow_payload.get("advancement_policy") != "ai"
    ):
        return None
    issue = (
        db.query(LoopItem)
        .filter(LoopItem.id == str(run.task_id))
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if issue is None or str(issue.cloud_project_id) != str(run.cloud_project_id):
        return None
    metadata = dict(issue.metadata_json or {})
    workflow = metadata.get("workflow")
    if (
        not isinstance(workflow, dict)
        or workflow.get("orchestration_status") != "planning"
    ):
        return issue
    active_run_id = workflow.get("active_run_id")
    active_run = (
        db.get(ProjectWorkflowRun, active_run_id)
        if isinstance(active_run_id, str)
        else None
    )
    if (
        active_run is None
        or active_run.parent_id != issue.id
        or str(active_run.cloud_project_id) != str(issue.cloud_project_id)
    ):
        return issue
    active_run.status = "failed"
    active_run.version += 1
    next_workflow = dict(workflow)
    next_workflow["version"] = int(workflow.get("version") or 1) + 1
    next_workflow["orchestration_status"] = "failed"
    metadata["workflow"] = next_workflow
    issue.metadata_json = metadata
    issue.version += 1
    return issue


COMPLETED_NODE_STATUSES = {"completed", "forced_completed"}


def apply_workflow_nodes(
    item: LoopItem,
    *,
    workflow: dict,
    nodes: list[dict],
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
    item.metadata_json = metadata
    required = [node for node in nodes if node.get("required", True)]
    if required and all(
        node.get("status") in COMPLETED_NODE_STATUSES for node in required
    ):
        item.status = "in_review"
    elif any(node.get("status") in {"running", "changes_requested"} for node in nodes):
        item.status = "in_progress"
    else:
        item.status = "pending"
    item.version += 1
    return item


def update_workflow_node(
    db: Session,
    *,
    item_id: str,
    node_id: str,
    node_status: str,
    automation_run_id: str | None = None,
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
        nodes.append(node)

    if not changed:
        return item
    return apply_workflow_nodes(item, workflow=workflow, nodes=nodes)


def sync_automation_workflow_node(
    db: Session, run: ProjectAutomationRun
) -> LoopItem | None:
    metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
    node_id = metadata.get("workflow_node_id")
    if not isinstance(node_id, str) or not node_id or not run.task_id:
        return _sync_coordinator_failure(db, run)
    status_map = {
        "pending": "queued",
        "queued": "queued",
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
    return update_workflow_node(
        db,
        item_id=str(run.task_id),
        node_id=node_id,
        node_status=node_status,
        automation_run_id=str(run.id),
    )
