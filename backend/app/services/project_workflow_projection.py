# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project trusted task and automation states onto one Issue workflow."""

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, LoopItemTaskBinding, ProjectAutomationRun

COMPLETED_NODE_STATUSES = {"completed", "forced_completed"}
SUCCESS_TASK_STATUSES = {"succeeded", "archived"}
FAILED_TASK_STATUSES = {"failed", "cancelled"}


def reconcile_workflow_task_nodes(
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
        if node.get("status") in COMPLETED_NODE_STATUSES:
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
        if any(task_statuses.get(task_id) == "running" for task_id in ordered_task_ids):
            node["status"] = "running"
        else:
            latest_status = task_statuses.get(ordered_task_ids[0])
            if latest_status in SUCCESS_TASK_STATUSES:
                node["status"] = (
                    "completed"
                    if node.get("automation_rule_id")
                    else "awaiting_approval"
                )
            elif latest_status in FAILED_TASK_STATUSES:
                node["status"] = "failed"
            else:
                node["status"] = "queued"
        node["task_ids"] = ordered_task_ids
        reconciled.append(node)
    return reconciled


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
        return None
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
