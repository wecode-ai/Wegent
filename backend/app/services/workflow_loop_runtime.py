# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Event-driven loop state machines inside one flat Issue workflow."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectIncomingEvent, loop_datetime_is_unset
from app.services.project_automation_domain import ProjectAutomationEvent

logger = logging.getLogger(__name__)

COMPLETED = {"completed", "forced_completed"}


def loop_nodes(nodes: list[dict]) -> list[dict]:
    return [node for node in nodes if node.get("node_type") == "loop"]


def branch_node(nodes: list[dict], loop: Mapping[str, Any]) -> dict | None:
    body_ids = set(loop.get("body_node_ids") or [])
    return next(
        (
            node
            for node in nodes
            if node.get("id") in body_ids and node.get("node_type") == "branch"
        ),
        None,
    )


def body_nodes(nodes: list[dict], loop: Mapping[str, Any]) -> list[dict]:
    body_ids = set(loop.get("body_node_ids") or [])
    return [node for node in nodes if node.get("id") in body_ids]


def root_branch_nodes(nodes: list[dict]) -> list[dict]:
    """Branch routers placed directly in the workflow, outside any loop."""

    return [
        node
        for node in nodes
        if node.get("node_type") == "branch" and not node.get("loop_id")
    ]


def _condition_key(source: object, event_type: object) -> str:
    if source is None:
        source = "wework" if str(event_type).startswith("task.") else "github"
    return f"{source}:{str(event_type or '')}"


def active_loop_timeout_expired(loop: Mapping[str, Any]) -> bool:
    deadline = loop.get("loop_deadline")
    if not deadline or loop.get("loop_state") != "active":
        return False
    try:
        parsed = datetime.fromisoformat(str(deadline))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) >= parsed


def _complete_loop(
    loop: dict,
    nodes: list[dict],
    *,
    exit_reason: str,
) -> None:
    loop["loop_state"] = "completed"
    loop["exit_reason"] = exit_reason
    loop["loop_deadline"] = None
    loop["status"] = "forced_completed" if exit_reason == "forced" else "completed"
    for node in body_nodes(nodes, loop):
        if node.get("status") not in COMPLETED:
            node["status"] = "completed"


def _activate_loop(loop: dict, nodes: list[dict]) -> None:
    loop["loop_state"] = "active"
    loop["status"] = "running"
    loop["activated_at"] = datetime.now(timezone.utc).isoformat()
    loop_config = loop.get("loop_config") or {}
    timeout_seconds = loop_config.get("timeout_seconds")
    if timeout_seconds:
        loop["loop_deadline"] = (
            datetime.now(timezone.utc) + timedelta(seconds=int(timeout_seconds))
        ).isoformat()
    for node in body_nodes(nodes, loop):
        if node.get("node_type") == "loop_start" and node.get("status") == "blocked":
            node["status"] = "ready"


def _start_reaction(branch: dict, event: Mapping[str, Any]) -> None:
    branch["status"] = "reacting"
    branch["active_condition"] = _condition_key(
        event.get("source"), event["event_type"]
    )
    branch["last_event"] = _event_snapshot(event)


def _event_snapshot(event: Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(event, ProjectAutomationEvent):
        payload = event.payload
        source = event.source
        event_type = event.event_type
        event_id = event.event_id
        subject_id = event.subject_id
    else:
        payload = event.get("payload")
        source = event.get("source")
        event_type = event.get("event_type")
        event_id = event.get("event_id")
        subject_id = event.get("subject_id")
    return {
        "source": source or "github",
        "event_type": event_type,
        "event_id": event_id or "",
        "subject_id": subject_id or "",
        "payload": dict(payload) if isinstance(payload, Mapping) else {},
    }


def _release_handlers(branch: dict, nodes: list[dict], handler_ids: set[str]) -> None:
    """Release direct handlers with the event that matched their condition."""

    snapshot = branch.get("last_event")
    snapshot = dict(snapshot) if isinstance(snapshot, dict) else None
    for node in nodes:
        if node.get("id") not in handler_ids or node.get("node_type") != "task":
            continue
        if node.get("status") in COMPLETED:
            node.pop("trigger_event", None)
        elif snapshot is not None and node.get("status") == "blocked":
            node["trigger_event"] = snapshot


def _consume_pending(branch: dict) -> None:
    pending = branch.get("pending_events")
    if not isinstance(pending, list) or not pending:
        return
    event = pending.pop(0)
    _start_reaction(branch, event)


def advance_loops(
    nodes: list[dict],
    *,
    on_branch_armed: Any = None,
) -> None:
    """Advance every loop state machine in place after dependency release."""

    for loop in loop_nodes(nodes):
        _advance_loop(loop, nodes, on_branch_armed=on_branch_armed)


def advance_root_branches(nodes: list[dict]) -> None:
    """Advance top-level branch routers in place.

    A root branch arms once its dependencies complete, waits for a matching
    event, releases the condition handlers, and completes one-shot when those
    handlers finish (no re-arming, unlike loop branches).
    """

    completed = {
        node.get("id")
        for node in nodes
        if node.get("status") in COMPLETED and node.get("id")
    }
    by_id = {node.get("id"): node for node in nodes if node.get("id")}
    for branch in root_branch_nodes(nodes):
        if branch.get("status") == "blocked":
            deps = set(branch.get("depends_on") or [])
            if deps <= completed:
                branch["status"] = "waiting"
        for _ in range(20):
            if branch.get("status") == "waiting":
                _consume_pending(branch)
                if branch.get("status") == "waiting":
                    break
            if branch.get("status") != "reacting":
                break
            conditions = {
                _condition_key(
                    condition.get("source_type"), condition.get("event_type")
                ): condition
                for condition in (branch.get("branch_conditions") or [])
                if isinstance(condition, dict)
            }
            condition = conditions.get(branch.get("active_condition"))
            if condition is None:
                branch["status"] = "waiting"
                branch["active_condition"] = None
                continue
            handler_ids = set(condition.get("handler_node_ids") or [])
            handlers = [
                by_id[handler_id] for handler_id in handler_ids if handler_id in by_id
            ]
            if not handlers:
                branch["status"] = "waiting"
                branch["active_condition"] = None
                continue
            for handler in handlers:
                if handler.get("status") != "blocked":
                    continue
                handler_deps = set(handler.get("depends_on") or [])
                handler_deps.discard(branch.get("id"))
                if handler_deps <= completed:
                    handler["status"] = "ready"
            _release_handlers(branch, nodes, handler_ids)
            if not all(handler.get("status") in COMPLETED for handler in handlers):
                break
            completed.update(handler.get("id") for handler in handlers)
            # A root branch fires at most one condition per arm. Sibling
            # handlers that were not released must not be treated as sequential
            # successors, so skip them instead of letting the generic DAG
            # promoter dispatch them after the branch completes.
            sibling_ids = {
                str(handler_id)
                for condition in (branch.get("branch_conditions") or [])
                if isinstance(condition, dict)
                for handler_id in (condition.get("handler_node_ids") or [])
            }
            for sibling_id in sibling_ids:
                sibling = by_id.get(sibling_id)
                if sibling is None or sibling.get("status") in COMPLETED:
                    continue
                sibling["status"] = "completed"
                completed.add(sibling_id)
            branch["status"] = "completed"
            branch["active_condition"] = None


def _advance_loop(
    loop: dict,
    nodes: list[dict],
    *,
    on_branch_armed: Any = None,
) -> None:
    """Advance one loop shell in place.

    A loop is a container that repeatedly runs its body. The body is a small
    DAG of body-scoped nodes. Each iteration enters through ``loop_start``
    (when present), runs its task nodes in dependency order, and counts as one
    attempt. Exits happen on ``loop_end`` completion, ``max_attempts``,
    ``timeout``, or a human ``forced`` advance.

    A ``branch`` inside the body is an ordinary event router (like a top-level
    branch); it is not the loop's driver. When the body has no branch, the loop
    is a plain sequential shell that repeats ``max_attempts`` times.
    """

    if loop.get("loop_state") == "completed":
        return
    completed = {
        node.get("id")
        for node in nodes
        if node.get("status") in COMPLETED and node.get("id")
    }
    deps = set(loop.get("depends_on") or [])
    if loop.get("loop_state") == "idle":
        if not deps <= completed:
            return
        _activate_loop(loop, nodes)
    if loop.get("loop_state") != "active":
        return
    if active_loop_timeout_expired(loop):
        _complete_loop(loop, nodes, exit_reason="timeout")
        return

    body = body_nodes(nodes, loop)
    branch = branch_node(nodes, loop)
    start = next((node for node in body if node.get("node_type") == "loop_start"), None)
    end = next((node for node in body if node.get("node_type") == "loop_end"), None)
    max_attempts = int((loop.get("loop_config") or {}).get("max_attempts") or 0)

    # A bounded sweep keeps one call advancing until the body must wait on a
    # task, a branch event, or a terminal exit.
    for _ in range(20):
        if start is not None and start.get("status") == "ready":
            start["status"] = "completed"
        completed = {
            node.get("id")
            for node in nodes
            if node.get("status") in COMPLETED and node.get("id")
        }

        # Promote body work nodes (task + loop_end) whose deps are satisfied.
        for node in body:
            if node.get("node_type") in {"loop_start", "branch"}:
                continue
            if node.get("status") == "blocked" and all(
                dep in completed for dep in (node.get("depends_on") or [])
            ):
                node["status"] = "ready"

        # Arm a body branch once its deps are satisfied.
        if branch is not None and branch.get("status") == "blocked":
            if all(dep in completed for dep in (branch.get("depends_on") or [])):
                branch["status"] = "waiting"
                if on_branch_armed is not None:
                    on_branch_armed(loop, branch, body)

        # Drive a body branch reaction.
        if branch is not None and branch.get("status") in {"waiting", "reacting"}:
            if branch.get("status") == "waiting":
                _consume_pending(branch)
            if branch.get("status") == "reacting":
                conditions = {
                    _condition_key(
                        condition.get("source_type"), condition.get("event_type")
                    ): condition
                    for condition in (branch.get("branch_conditions") or [])
                    if isinstance(condition, dict)
                }
                condition = conditions.get(branch.get("active_condition"))
                if condition is None:
                    branch["status"] = "waiting"
                    branch["active_condition"] = None
                else:
                    handler_ids = set(condition.get("handler_node_ids") or [])
                    _release_handlers(branch, nodes, handler_ids)
                    for node in body:
                        if (
                            node.get("id") in handler_ids
                            and node.get("status") == "blocked"
                        ):
                            node_deps = set(node.get("depends_on") or [])
                            node_deps.discard(branch.get("id"))
                            if node_deps <= completed:
                                node["status"] = "ready"
                    handlers = [node for node in body if node.get("id") in handler_ids]
                    if handlers and all(
                        node.get("status") in COMPLETED for node in handlers
                    ):
                        branch["status"] = "waiting"
                        branch["active_condition"] = None

        completed = {
            node.get("id")
            for node in nodes
            if node.get("status") in COMPLETED and node.get("id")
        }

        # A completed loop_end is a terminal exit (event-driven or sequential).
        if end is not None:
            if end.get("status") == "ready":
                end["status"] = "completed"
            if end.get("status") in COMPLETED:
                _complete_loop(loop, nodes, exit_reason="loop_end")
                return

        # A reacting branch means the body is still waiting on an event handler.
        if branch is not None and branch.get("status") == "reacting":
            return

        # One body pass finishes once every task node is completed.
        tasks = [node for node in body if node.get("node_type") == "task"]
        if all(node.get("status") in COMPLETED for node in tasks):
            loop["attempts"] = int(loop.get("attempts") or 0) + 1
            if max_attempts > 0 and int(loop.get("attempts") or 0) >= max_attempts:
                _complete_loop(loop, nodes, exit_reason="max_attempts")
                return
            _reset_iteration(loop, nodes)
            continue

        # Nothing is ready to advance right now; wait for a later trigger.
        return


def _reset_iteration(loop: dict, nodes: list[dict]) -> None:
    """Rewind a body to its next pass while keeping the loop active."""

    for node in body_nodes(nodes, loop):
        if node.get("node_type") == "loop_start":
            node["status"] = "ready"
            continue
        node["status"] = "blocked"
        node["task_statuses"] = {}
        node["task_ids"] = []
        node["automation_run_id"] = None
        node["execution_id"] = None
        node.pop("trigger_event", None)


def _workflow_nodes(item: LoopItem) -> list[dict] | None:
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    workflow = metadata.get("workflow")
    if not isinstance(workflow, dict):
        return None
    nodes = workflow.get("nodes")
    return (
        [dict(node) for node in nodes if isinstance(node, dict)]
        if isinstance(nodes, list)
        else None
    )


def _save_workflow(item: LoopItem, nodes: list[dict], workflow: dict) -> None:
    next_workflow = dict(workflow)
    next_workflow["version"] = int(workflow.get("version") or 1) + 1
    next_workflow["nodes"] = nodes
    metadata = dict(item.metadata_json or {})
    metadata["workflow"] = next_workflow
    item.metadata_json = metadata
    item.version += 1


def _workflow_terminal(nodes: list[dict]) -> bool:
    required = [node for node in nodes if node.get("required", True)]
    return bool(required) and all(node.get("status") in COMPLETED for node in required)


def _subject_item(
    db: Session,
    event: ProjectAutomationEvent,
) -> LoopItem | None:
    """Resolve one event to the Issue its loop is waiting on."""

    if event.source == "wework":
        item = (
            db.query(LoopItem)
            .filter(LoopItem.id == event.subject_id)
            .with_for_update()
            .first()
        )
        if item is not None and str(item.cloud_project_id or "") == event.project_id:
            return item
        return None
    subject = event.payload.get("subject")
    if not isinstance(subject, dict):
        return None
    from app.services.project_change_request_bindings import (
        project_change_request_binding_service,
    )

    resolution = project_change_request_binding_service.resolve(
        db,
        project_id=event.project_id,
        subject=subject,
    )
    binding = resolution.binding
    if binding is None or not binding.loop_item_id:
        return None
    item = (
        db.query(LoopItem)
        .filter(LoopItem.id == binding.loop_item_id)
        .with_for_update()
        .first()
    )
    if item is None or str(item.cloud_project_id or "") != event.project_id:
        return None
    return item


def _matching_branch(
    nodes: list[dict],
    event: ProjectAutomationEvent,
) -> dict | None:
    candidates = [
        node
        for node in nodes
        if node.get("node_type") == "branch"
        and node.get("status") in {"waiting", "reacting"}
    ]
    for branch in candidates:
        conditions = branch.get("branch_conditions") or []
        if any(_condition_matches_event(condition, event) for condition in conditions):
            return branch
    return None


def _condition_matches_event(
    condition: object,
    event: ProjectAutomationEvent,
) -> bool:
    if not isinstance(condition, dict):
        return False
    source = condition.get("source_type")
    if source is None:
        source = "wework" if event.event_type.startswith("task.") else "github"
    return source == event.source and condition.get("event_type") == event.event_type


def route_event_to_workflow_loop(
    db: Session,
    event: ProjectAutomationEvent,
) -> LoopItem | None:
    """Route one external event to an armed loop branch, if any."""

    item = _subject_item(db, event)
    if item is None:
        return None
    nodes = _workflow_nodes(item)
    if nodes is None:
        return None
    branch = _matching_branch(nodes, event)
    if branch is None:
        return None
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    workflow = metadata.get("workflow")
    if not isinstance(workflow, dict):
        return None

    if branch.get("status") == "reacting":
        pending = branch.get("pending_events")
        if not isinstance(pending, list):
            pending = []
        event_id = event.event_id or ""
        if not any(
            isinstance(entry, dict) and entry.get("event_id") == event_id
            for entry in pending
        ):
            pending.append(_event_snapshot(event))
            branch["pending_events"] = pending
            _save_workflow(item, nodes, workflow)
            db.commit()
            db.refresh(item)
        return item

    _start_reaction(branch, _event_snapshot(event))
    advance_loops(nodes)
    advance_root_branches(nodes)
    if _workflow_terminal(nodes):
        from app.services.project_workflow_projection import apply_workflow_nodes

        apply_workflow_nodes(db, item, workflow=workflow, nodes=nodes)
    else:
        _save_workflow(item, nodes, workflow)
    db.commit()
    db.refresh(item)
    return item


def loop_handler_run_ids(item: LoopItem) -> list[str]:
    """Return in-flight handler automation run ids of active loops."""

    nodes = _workflow_nodes(item)
    if nodes is None:
        return []
    run_ids: list[str] = []
    for loop in loop_nodes(nodes):
        if loop.get("loop_state") != "active":
            continue
        branch = branch_node(nodes, loop)
        if branch is None or branch.get("status") != "reacting":
            continue
        conditions = {
            _condition_key(
                condition.get("source_type"), condition.get("event_type")
            ): condition
            for condition in (branch.get("branch_conditions") or [])
            if isinstance(condition, dict)
        }
        condition = conditions.get(branch.get("active_condition"))
        if condition is None:
            continue
        handler_ids = set(condition.get("handler_node_ids") or [])
        for node in body_nodes(nodes, loop):
            if (
                node.get("id") in handler_ids
                and node.get("automation_run_id")
                and node.get("status") not in COMPLETED
            ):
                run_ids.append(str(node["automation_run_id"]))
    return run_ids


def forced_loop_handler_run_ids(item: LoopItem) -> list[str]:
    """Return handler automation run ids of loops forced through by a human."""

    nodes = _workflow_nodes(item)
    if nodes is None:
        return []
    run_ids: list[str] = []
    for loop in loop_nodes(nodes):
        if loop.get("exit_reason") != "forced":
            continue
        branch = branch_node(nodes, loop)
        if branch is None:
            continue
        conditions = {
            _condition_key(
                condition.get("source_type"), condition.get("event_type")
            ): condition
            for condition in (branch.get("branch_conditions") or [])
            if isinstance(condition, dict)
        }
        condition = conditions.get(branch.get("active_condition"))
        if condition is None:
            continue
        handler_ids = set(condition.get("handler_node_ids") or [])
        for node in body_nodes(nodes, loop):
            if node.get("id") in handler_ids and node.get("automation_run_id"):
                run_ids.append(str(node["automation_run_id"]))
    return run_ids


async def dispatch_loop_handlers(
    db: Session,
    *,
    item: LoopItem,
    user_id: int,
) -> int:
    """Dispatch robot handler stages released by one loop reaction."""

    from app.services.issue_workflow_start import issue_workflow_start_service

    ready = issue_workflow_start_service.ready_robot_stage_ids(item)
    if not ready:
        return 0
    started = await issue_workflow_start_service.continue_ready_stages(
        db,
        item=item,
        user_id=user_id,
        stage_ids=ready,
    )
    return started


def _apply_condition_event(branch: dict, event: Mapping[str, Any]) -> None:
    """Apply one persisted event to a branch, queuing while reacting."""

    event_id = str(event.get("event_id") or "")
    if branch.get("status") == "reacting":
        pending = branch.get("pending_events")
        if not isinstance(pending, list):
            pending = []
        if not any(
            isinstance(entry, dict) and str(entry.get("event_id") or "") == event_id
            for entry in pending
        ):
            pending.append(
                {
                    "source": str(event.get("source") or ""),
                    "event_type": event.get("event_type"),
                    "event_id": event_id,
                    "subject_id": str(event.get("subject_id") or ""),
                }
            )
            branch["pending_events"] = pending
        return
    if branch.get("status") == "waiting":
        _start_reaction(branch, event)


def _subject_matches_item(
    db: Session,
    item: LoopItem,
    event: ProjectAutomationEvent,
) -> bool:
    candidate = _subject_item(db, event)
    return candidate is not None and str(candidate.id) == str(item.id)


def catch_up_branch_events(
    db: Session,
    item: LoopItem,
    *,
    loop: dict,
    branch: dict,
    nodes: list[dict],
) -> None:
    """Replay events persisted while the loop was not yet listening."""

    if loop.get("catch_up_done"):
        return
    loop["catch_up_done"] = True
    window_start = loop.get("activated_at")
    if not window_start:
        return
    try:
        since = datetime.fromisoformat(str(window_start))
    except ValueError:
        return
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    since = since.astimezone(timezone.utc).replace(tzinfo=None)
    conditions = [
        condition
        for condition in (branch.get("branch_conditions") or [])
        if isinstance(condition, dict)
    ]
    if not conditions:
        return
    rows = (
        db.query(ProjectIncomingEvent)
        .filter(
            ProjectIncomingEvent.cloud_project_id == item.cloud_project_id,
            ProjectIncomingEvent.status.in_(["processed", "ignored"]),
            loop_datetime_is_unset(ProjectIncomingEvent.deleted_at),
            ProjectIncomingEvent.created_at >= since,
        )
        .order_by(ProjectIncomingEvent.created_at.asc())
        .all()
    )
    for row in rows:
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        payload = metadata.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        for normalized in metadata.get("normalized_events") or []:
            if not isinstance(normalized, dict):
                continue
            event_type = normalized.get("event_type")
            subject = normalized.get("subject")
            subject = subject if isinstance(subject, dict) else {}
            event = ProjectAutomationEvent(
                event_type=event_type,
                project_id=str(item.cloud_project_id),
                subject_id=str(subject.get("id") or ""),
                subject_type=str(subject.get("type") or "unknown"),
                source=str(metadata.get("source") or row.source or "wework"),
                actor_user_id=row.created_by_user_id,
                payload={**payload, "subject": subject},
                event_id=str(row.public_id or row.id),
                subscription_id=str(row.parent_id or ""),
            )
            if not any(
                _condition_matches_event(condition, event) for condition in conditions
            ):
                continue
            if not _subject_matches_item(db, item, event):
                continue
            _apply_condition_event(branch, _event_snapshot(event))


def scan_loop_timeouts(db: Session) -> int:
    """Best-effort sweep completing loops whose deadlines have passed."""

    from sqlalchemy import func

    metadata = LoopItem.metadata_json
    dialect = db.get_bind().dialect.name
    if dialect == "mysql":
        state_values = func.json_extract(metadata, "$.workflow.nodes[*].loop_state")
        condition = func.json_contains(state_values, '"active"') == 1
    else:
        condition = metadata.like('%"loop_state": "active"%')
    items = (
        db.query(LoopItem)
        .filter(
            LoopItem.cloud_project_id.isnot(None),
            loop_datetime_is_unset(LoopItem.deleted_at),
            condition,
        )
        .all()
    )
    completed = 0
    for item in items:
        nodes = _workflow_nodes(item)
        if nodes is None:
            continue
        metadata_dict = (
            item.metadata_json if isinstance(item.metadata_json, dict) else {}
        )
        workflow = metadata_dict.get("workflow")
        if not isinstance(workflow, dict):
            continue
        before = {
            node.get("id")
            for node in loop_nodes(nodes)
            if node.get("loop_state") == "completed"
        }
        advance_loops(nodes)
        after = {
            node.get("id")
            for node in loop_nodes(nodes)
            if node.get("loop_state") == "completed"
        }
        if after - before:
            from app.services.project_workflow_projection import (
                apply_workflow_nodes,
            )

            apply_workflow_nodes(db, item, workflow=workflow, nodes=nodes)
            completed += 1
            logger.info(
                "[LoopRuntime] timeout sweep completed item=%s loops=%s",
                item.id,
                sorted(after - before),
            )
    if completed:
        db.commit()
    return completed
