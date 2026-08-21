# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project trusted task and automation states onto one Issue workflow."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    LoopItemTaskBinding,
    ProjectAutomationRun,
    ProjectWorkflowRun,
    loop_datetime_is_unset,
)
from app.services.loop_item_unread import advance_content_revision

COMPLETED_NODE_STATUSES = {"completed", "forced_completed"}
SUCCESS_TASK_STATUSES = {"succeeded", "archived"}
FAILED_TASK_STATUSES = {"failed", "cancelled"}


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
        if not node.get("automation_rule_id"):
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
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud context not found")
    if not binding.loop_item_id or not binding.workflow_node_id:
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
        nodes.append(node)
    if not changed:
        return item
    return apply_workflow_nodes(item, workflow=workflow, nodes=nodes)


def apply_workflow_nodes(
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
    if not isinstance(node_id, str) or not node_id:
        return _sync_ai_planning_run(db, run, metadata)
    if not run.task_id:
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
    return issue
