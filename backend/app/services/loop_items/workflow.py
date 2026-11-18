# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authoritative decisions over the existing Issue workflow snapshot."""

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import Delivery, LoopItem, LoopItemComment
from app.schemas.base_role import BaseRole
from app.schemas.issue_workflow import (
    IssueWorkflowInstance,
    ProjectWorkflowDefinition,
    WorkflowAction,
    WorkflowNodeDecision,
    WorkflowNodeInstance,
    instantiate_workflow,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_item_unread import advance_content_revision
from app.services.loop_items.workflow_observability import (
    record_workflow_event,
    record_workflow_invariant,
    stage_durations,
)
from shared.telemetry.decorators import set_span_attribute, trace_sync

COMPLETED = {"completed", "forced_completed"}


def workflow_snapshot(item: LoopItem) -> IssueWorkflowInstance | None:
    raw = (item.metadata_json or {}).get("workflow")
    return IssueWorkflowInstance.model_validate(raw) if isinstance(raw, dict) else None


def require_pristine_workflow(workflow: IssueWorkflowInstance) -> None:
    definition = ProjectWorkflowDefinition(
        **workflow.model_dump(
            exclude={
                "version",
                "definition_version",
                "orchestration_status",
                "active_run_id",
                "active_plan_version",
                "current_stage_id",
                "nodes",
            }
        ),
        version=workflow.definition_version,
        nodes=[node.model_dump() for node in workflow.nodes],
    )
    expected = instantiate_workflow(definition)
    # Runtime fields can only be created by the server, including task/evidence IDs.
    if workflow.model_dump() != expected.model_dump():
        raise HTTPException(422, "New Issues must start with a pristine workflow")


def require_workflow_complete(item: LoopItem, next_status: str | None) -> None:
    workflow = workflow_snapshot(item)
    if workflow and workflow.strategy_state == "inbox" and next_status == "completed":
        raise HTTPException(409, "Admit the inbox Issue before completing its strategy")
    if next_status != "completed" or workflow is None:
        return
    pending = [
        node.id
        for node in workflow.nodes
        if node.required and node.status not in COMPLETED
    ]
    if pending:
        raise HTTPException(
            409,
            {
                "code": "workflow_incomplete",
                "current_stage_id": workflow.current_stage_id,
                "pending_node_ids": pending,
                "message": "Complete the required workflow stages before completing the Issue",
            },
        )


def require_ready_node(
    workflow: IssueWorkflowInstance, node_id: str
) -> WorkflowNodeInstance:
    node = next((entry for entry in workflow.nodes if entry.id == node_id), None)
    if node is None:
        raise HTTPException(404, "Workflow stage not found")
    states = {entry.id: entry.status for entry in workflow.nodes}
    missing = [
        dependency
        for dependency in node.depends_on
        if states[dependency] not in COMPLETED
    ]
    if missing or node.status in COMPLETED | {"blocked"}:
        record_workflow_event(
            "gate_rejected",
            node_id=node.id,
            strategy_id="agentic_strategy" if workflow.strategy_snapshot else None,
            reason="missing_dependencies" if missing else "stage_not_active",
        )
        raise HTTPException(
            409,
            {
                "code": "workflow_stage_blocked",
                "current_stage_id": workflow.current_stage_id,
                "node_id": node.id,
                "missing_dependencies": missing,
                "message": "This workflow stage is not active",
            },
        )
    return node


def missing_deliverables(
    db: Session, item: LoopItem, node: WorkflowNodeInstance
) -> list[dict]:
    requirements = {entry.id: entry for entry in node.required_deliverables}
    fulfilled: set[str] = set()
    deliveries = (
        db.query(Delivery)
        .filter(
            Delivery.loop_item_id == item.id,
            Delivery.status == "delivered",
            Delivery.id.in_(node.delivery_ids),
        )
        .all()
        if node.delivery_ids
        else []
    )
    for delivery in deliveries:
        metadata = delivery.metadata_json or {}
        if (
            metadata.get("workflow_node_id") != node.id
            or metadata.get("workflow_attempt") != node.attempts
        ):
            continue
        for value in metadata.get("fulfillments", []):
            requirement = requirements.get(value.get("requirement_id"))
            if (
                requirement is not None
                and value.get("kind")
                in {requirement.value_type, *requirement.accepted_value_types}
                and (
                    requirement.pull_request_state is None
                    or value.get("state") == requirement.pull_request_state
                )
            ):
                fulfilled.add(requirement.id)
    missing = [
        entry.model_dump(mode="json")
        for entry in node.required_deliverables
        if entry.id not in fulfilled
    ]
    return missing


def require_deliverables(
    db: Session, item: LoopItem, node: WorkflowNodeInstance
) -> None:
    missing = missing_deliverables(db, item, node)
    if missing:
        record_workflow_event(
            "gate_rejected",
            node_id=node.id,
            reason="missing_deliverables",
            strategy_id=(
                "agentic_strategy"
                if workflow_snapshot(item).strategy_snapshot
                else None
            ),
        )
        raise HTTPException(
            409,
            {
                "code": "workflow_deliverables_missing",
                "current_stage_id": node.id,
                "missing_deliverables": missing,
                "message": "Submit the missing stage deliverables before approval",
            },
        )


def _related_nodes(
    workflow: IssueWorkflowInstance, node_id: str, *, ancestors: bool
) -> set[str]:
    selected: set[str] = set()
    pending = [node_id]
    while pending:
        current = pending.pop()
        adjacent = (
            next(entry.depends_on for entry in workflow.nodes if entry.id == current)
            if ancestors
            else [entry.id for entry in workflow.nodes if current in entry.depends_on]
        )
        for entry_id in adjacent:
            if entry_id not in selected:
                selected.add(entry_id)
                pending.append(entry_id)
    return selected


def _activate(
    workflow: IssueWorkflowInstance, now: datetime
) -> list[WorkflowNodeInstance]:
    states = {node.id: node.status for node in workflow.nodes}
    activated = []
    for node in workflow.nodes:
        if node.status == "blocked" and all(
            states[dependency] in COMPLETED for dependency in node.depends_on
        ):
            node.status = "ready"
            node.attempts += 1
            node.activated_at = now
            activated.append(node)
    workflow.current_stage_id = next(
        (
            node.id
            for node in workflow.nodes
            if node.status not in COMPLETED | {"blocked"}
        ),
        None,
    )
    if all(node.status in COMPLETED for node in workflow.nodes):
        workflow.orchestration_status = "completed"
    else:
        workflow.orchestration_status = "running"
    return activated


def route_workflow_stages(
    db: Session, item: LoopItem, user_id: int, nodes: list[WorkflowNodeInstance]
) -> None:
    """Use the existing assignment path and its current project/resource grants."""
    from app.schemas.project_chat import LoopItemAssign
    from app.services.loop_items.service import loop_item_service

    for node in nodes:
        node.attempts = max(1, node.attempts)
        node.activated_at = node.activated_at or datetime.now(timezone.utc)
        target_type, target_id = node.required_assignee_type, node.required_assignee_id
        if not target_id and node.execution_mode == "robot":
            workflow = workflow_snapshot(item)
            config = workflow.execution_config_for(node) if workflow else None
            target_type, target_id = "agent", config.agent_id if config else None
            if not target_id:
                node.execution_error = (
                    "Configure an authorized project assistant for this stage"
                )
        if not target_type or not target_id:
            continue
        workflow = workflow_snapshot(item)
        context = {
            "workflow_stage_input": {
                "target_stage": node.model_dump(mode="json"),
                "dependencies": [
                    entry.model_dump(mode="json")
                    for entry in workflow.nodes
                    if entry.id in node.depends_on
                ],
            },
            "workflow_stage_id": node.id,
            "workflow_attempt": node.attempts,
            "workflow_task_title": node.name,
        }
        if target_type == "agent":
            from app.models.delivery import ProjectChatAgent
            from app.services.issue_execution_configuration import (
                execution_context,
                project_robot_execution_config,
            )

            agent = db.get(ProjectChatAgent, target_id)
            if agent is not None:
                context = {
                    **execution_context(
                        project_robot_execution_config(db, agent),
                        runtime_subject_user_id=int(
                            agent.created_by_user_id or user_id
                        ),
                    ),
                    **context,
                }
        loop_item_service.assign(
            db,
            project_id=int(item.cloud_project_id),
            item_id=item.id,
            user_id=user_id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type=target_type,
                assignee_id=target_id,
                workflow_step=node.id,
                trigger="automation",
                notify_assignee=True,
            ),
            instruction=node.prompt
            or f"Complete workflow stage {node.name} and submit its required deliverables.",
            automation_context=context,
            commit=False,
        )
        if target_type in {"agent", "team"}:
            from app.models.loop_item_execution import LoopItemExecution

            execution = (
                db.query(LoopItemExecution)
                .filter(
                    LoopItemExecution.loop_item_id == item.id,
                )
                .order_by(LoopItemExecution.id.desc())
                .first()
            )
            if (
                execution is not None
                and execution.runtime_origin_context.get("workflow_stage_id") == node.id
            ):
                node.execution_id = execution.id


def _retire_assignments(
    db: Session, item: LoopItem, user_id: int, node_ids: set[str]
) -> list:
    from app.models.loop_item_execution import LoopItemExecution
    from app.services.issue_assignments import issue_assignment_service
    from app.services.loop_item_executions.service import loop_item_execution_service
    from app.services.loop_items.service import CANCELLABLE_EXECUTION_STATUSES

    for assignment in issue_assignment_service.active_for_issue(db, item.id):
        if assignment.workflow_step in node_ids:
            issue_assignment_service.remove(
                db,
                project_id=int(item.cloud_project_id),
                issue_id=item.id,
                assignment_id=assignment.id,
                user_id=user_id,
            )
    cancelled = []
    for execution in (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.status.in_(CANCELLABLE_EXECUTION_STATUSES),
        )
        .all()
    ):
        context = execution.runtime_origin_context
        if context.get("workflow_stage_id") in node_ids:
            cancelled.append(
                loop_item_execution_service.cancel(
                    db,
                    execution_id=execution.id,
                    note="Workflow stage completed or requested rework",
                    commit=False,
                )
            )
    return cancelled


def _audit(
    db: Session,
    item: LoopItem,
    user_id: int,
    action: WorkflowAction,
    node: WorkflowNodeInstance | None,
    skipped: list[str],
    source: str,
) -> None:
    db.add(
        LoopItemComment(
            cloud_project_id=str(item.cloud_project_id),
            loop_item_id=item.id,
            description=f"Workflow {action.action or action.type}: {node.name if node else 'project workflow'}"
            + (f" — {action.reason}" if action.reason else "")
            + (f"\nSkipped stages: {', '.join(skipped)}" if skipped else ""),
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            status="active",
            metadata_json={
                "event_type": "workflow_decision",
                "action": action.action or action.type,
                "node_id": node.id if node else None,
                "reason": action.reason,
                "skipped_node_ids": skipped,
                "source": source,
                "decided_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    )


@trace_sync("loop_items.workflow_action", tracer_name="backend")
def apply_workflow_action(
    db: Session,
    item: LoopItem,
    user_id: int,
    action: WorkflowAction,
    version: int,
    *,
    actor_is_human: bool,
    commit: bool,
) -> LoopItem:
    item = (
        db.query(LoopItem)
        .filter(LoopItem.id == item.id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    metadata = dict(item.metadata_json or {})
    previous_status = item.status
    set_span_attribute("workflow.issue_id", item.id)
    set_span_attribute("workflow.project_id", str(item.cloud_project_id))
    set_span_attribute("workflow.action", action.action or action.type)
    if action.node_id:
        set_span_attribute("workflow.stage_id", action.node_id)
    receipts = dict(metadata.get("workflow_decision_receipts") or {})
    fingerprint = {
        **action.model_dump(mode="json"),
        "actor_user_id": user_id,
        "actor_is_human": actor_is_human,
    }
    if action.idempotency_key in receipts:
        if receipts[action.idempotency_key] != fingerprint:
            raise HTTPException(
                409,
                "Idempotency key was already used for a different workflow decision",
            )
        return item
    if item.version != version:
        raise HTTPException(
            409, {"code": "version_conflict", "message": "TODO changed"}
        )
    workflow = workflow_snapshot(item)
    now = datetime.now(timezone.utc)
    node, skipped, cancelled_runs = None, [], []
    durations: dict[str, float] = {}
    if action.type in {
        "admit",
        "upgrade_strategy",
        "evaluate",
        "record_coordinator_decision",
        "set_stage_state",
        "record_stage_review",
        "record_release",
    }:
        from app.services.loop_items.strategy import apply_strategy_action

        workflow, activated = apply_strategy_action(
            db, item, user_id, workflow, action, actor_is_human=actor_is_human
        )
    elif action.type == "apply_project":
        if item.status == "completed":
            raise HTTPException(
                409, "Reopen the Issue before applying a project workflow"
            )
        if workflow is not None:
            raise HTTPException(
                409, "This Issue already has a workflow; history cannot be replaced"
            )
        project = db.get(CloudProject, item.cloud_project_id)
        if (project.metadata_json or {}).get("collaboration_strategy"):
            from app.services.loop_items.strategy import (
                inbox_snapshot,
                strategy_enabled,
            )

            if (
                not actor_is_human
                or not action.reason.strip()
                or not action.idempotency_key
            ):
                raise HTTPException(
                    403,
                    "Applying a strategy requires human confirmation, reason and idempotency key",
                )
            if not strategy_enabled(project):
                raise HTTPException(409, "Agentic collaboration strategy is disabled")
            workflow = inbox_snapshot(project.metadata_json["collaboration_strategy"])
            item.status = "inbox"
            activated = []
        else:
            definition = ProjectWorkflowDefinition.model_validate(
                (project.metadata_json or {}).get("workflow_definition") or {}
            )
            if definition.stage_mode != "dag" or not definition.nodes:
                raise HTTPException(
                    409, "Configure a project workflow before applying it"
                )
            workflow = instantiate_workflow(definition)
            activated = [entry for entry in workflow.nodes if entry.status == "ready"]
    else:
        if workflow is None:
            raise HTTPException(409, "This Issue has no workflow")
        node = next(
            (entry for entry in workflow.nodes if entry.id == action.node_id), None
        )
        if node is None:
            raise HTTPException(404, "Workflow stage not found")
        if workflow.strategy_snapshot is not None:
            from app.services.loop_items.strategy import require_stage_actor

            if not action.idempotency_key:
                raise HTTPException(
                    422, "Strategy decisions require an idempotency key"
                )
            require_stage_actor(db, item, user_id, workflow, node.id)
            if action.rework_to is not None and (
                action.action != "reject"
                or node.id != "quality_acceptance"
                or action.rework_to
                not in {"development_preparation", "development_implementation"}
            ):
                raise HTTPException(
                    422,
                    "Rework must target development preparation or implementation from quality acceptance",
                )
        if not actor_is_human and (
            node.human_approval_required
            or node.id == "merge_release"
            or action.action == "force_advance"
            or workflow.approval_policy != "automatic"
            or node.execution_mode != "robot"
        ):
            record_workflow_event(
                "gate_rejected",
                node_id=node.id,
                strategy_id="agentic_strategy" if workflow.strategy_snapshot else None,
                source="assistant",
                reason="human_confirmation_required",
            )
            raise HTTPException(
                403, "This workflow decision requires authorized human confirmation"
            )
        durations = stage_durations(db, item, node, now)
        if action.action == "force_advance":
            require_cloud_project_role(
                db, int(item.cloud_project_id), user_id, BaseRole.Maintainer
            )
            if node.status in COMPLETED:
                raise HTTPException(409, "This workflow stage already completed")
            skipped = sorted(
                _related_nodes(workflow, node.id, ancestors=True) | {node.id}
            )
            skipped = [
                entry_id
                for entry_id in skipped
                if next(
                    entry.status for entry in workflow.nodes if entry.id == entry_id
                )
                not in COMPLETED
            ]
            for entry in workflow.nodes:
                if entry.id in skipped:
                    entry.status = "forced_completed"
            cancelled_runs = _retire_assignments(db, item, user_id, set(skipped))
        elif action.action == "approve":
            if workflow.strategy_snapshot is not None:
                from app.services.loop_items.strategy_reviews import (
                    require_stage_review_gate,
                )

                require_stage_review_gate(db, item, workflow, node)
            require_ready_node(workflow, node.id)
            require_deliverables(db, item, node)
            node.status = "completed"
            cancelled_runs = _retire_assignments(db, item, user_id, {node.id})
        elif (
            action.action == "reject"
            and node.id == "quality_acceptance"
            and workflow.strategy_snapshot is not None
        ):
            require_ready_node(workflow, node.id)
            node.attempts += 1
            node.status = "ready"
            node.deliverables_completed_at = None
            workflow.quality_blocked = True
            cancelled_runs = _retire_assignments(db, item, user_id, {node.id})
            from app.services.loop_items.strategy_reviews import _assign_stage_owner

            _assign_stage_owner(
                db,
                item,
                user_id,
                workflow,
                node,
                "development",
            )
        else:
            require_ready_node(workflow, node.id)
            target_id = action.rework_to or node.rework_to or node.id
            reset_ids = _related_nodes(workflow, target_id, ancestors=False) | {
                target_id
            }
            cancelled_runs = _retire_assignments(db, item, user_id, reset_ids)
            for entry in workflow.nodes:
                if entry.id in reset_ids:
                    entry.status = "blocked"
                    entry.execution_id = None
                    entry.automation_run_id = None
                    entry.execution_error = None
                    entry.deliverables_completed_at = None
        node.decision_history.append(
            WorkflowNodeDecision(
                action=action.action,
                actor_user_id=user_id,
                reason=action.reason,
                decided_at=now,
                skipped_node_ids=skipped,
                source="human" if actor_is_human else "assistant",
                stage_durations_seconds=durations,
            )
        )
        activated = _activate(workflow, now)
        workflow.version += 1
    if workflow.strategy_snapshot is not None:
        from app.services.loop_items.strategy import (
            notify_strategy_event,
            synchronize_strategy_stage,
        )

        synchronize_strategy_stage(item, workflow)
        if action.type == "decide_node":
            notify_strategy_event(
                db,
                item,
                user_id,
                workflow,
                {
                    "approve": "stage_completed",
                    "reject": (
                        "quality_rework"
                        if node is not None and node.id == "quality_acceptance"
                        else "stage_reworked"
                    ),
                    "force_advance": "stage_forced",
                }[action.action],
                action.reason,
                changed_stage=node.name,
                skipped_stages=[
                    entry.name for entry in workflow.nodes if entry.id in skipped
                ],
            )
        elif action.type == "apply_project":
            notify_strategy_event(
                db, item, user_id, workflow, "strategy_applied", action.reason
            )
        for entry in activated:
            notify_strategy_event(
                db,
                item,
                user_id,
                workflow,
                "stage_started",
                changed_stage=entry.name,
            )
        metadata = dict(item.metadata_json or {})
        if item.status != previous_status:
            from app.services.loop_item_status_history import write_status_change

            write_status_change(
                metadata,
                project=db.get(CloudProject, item.cloud_project_id),
                from_status=previous_status,
                to_status=item.status,
                trigger="workflow_decision",
                by_user_id=user_id,
            )
            item.completed_at = (
                now.replace(tzinfo=None) if item.status == "completed" else None
            )
            item.metadata_json = metadata
        if action.type == "upgrade_strategy" and activated:
            cancelled_runs = _retire_assignments(
                db, item, user_id, {entry.id for entry in activated}
            )
    metadata["workflow"] = workflow.model_dump(mode="json")
    item.metadata_json = metadata
    db.flush()
    route_workflow_stages(db, item, user_id, activated)
    if workflow.strategy_snapshot is not None:
        synchronize_strategy_stage(item, workflow)
    metadata = dict(item.metadata_json or {})
    metadata["workflow"] = workflow.model_dump(mode="json")
    if action.idempotency_key:
        receipts[action.idempotency_key] = fingerprint
        metadata["workflow_decision_receipts"] = receipts
    if action.type == "record_stage_review":
        item.metadata_json = metadata
    else:
        item.metadata_json = advance_content_revision(metadata, actor_user_id=user_id)
        item.version += 1
    if workflow.strategy_snapshot is not None and action.type not in {
        "record_coordinator_decision",
        "evaluate",
    }:
        from app.services.loop_items.strategy import refresh_strategy_coordinator

        refresh_strategy_coordinator(
            db,
            item,
            "strategy." + (action.action or action.type),
            "strategy:" + (action.idempotency_key or str(item.version)),
        )
    _audit(
        db,
        item,
        user_id,
        action,
        node,
        skipped,
        "human" if actor_is_human else "assistant",
    )
    if commit:
        db.commit()
    else:
        db.flush()
    db.refresh(item)
    if commit:
        from app.services.loop_item_events import publish_loop_item_changed

        publish_loop_item_changed(
            db,
            item=item,
            reason="workflow_decision",
            actor_user_id=user_id,
        )
        if workflow.strategy_snapshot is not None:
            from app.services.loop_items.strategy import push_strategy_summaries

            push_strategy_summaries(db)
        source = "human" if actor_is_human else "assistant"
        record_workflow_event(
            action.action or action.type,
            node_id=node.id if node else "",
            strategy_id="agentic_strategy" if workflow.strategy_snapshot else None,
            source=source,
            durations=durations,
        )
        if skipped:
            record_workflow_event(
                "stages_force_skipped",
                strategy_id="agentic_strategy" if workflow.strategy_snapshot else None,
                source=source,
                count=len(skipped),
            )
        for activated_node in activated:
            record_workflow_event(
                "stage_activated",
                node_id=activated_node.id,
                strategy_id="agentic_strategy" if workflow.strategy_snapshot else None,
            )
        states = {entry.id: entry.status for entry in workflow.nodes}
        record_workflow_invariant(
            "dependencies_satisfied_but_not_activated",
            sum(
                entry.status == "blocked"
                and not (
                    entry.id == workflow.current_stage_id
                    and entry.state_history
                    and entry.state_history[-1].get("to") == "blocked"
                )
                and all(
                    states[dependency] in COMPLETED for dependency in entry.depends_on
                )
                for entry in workflow.nodes
            ),
            "agentic_strategy" if workflow.strategy_snapshot else None,
        )
        if action.action == "approve":
            record_workflow_invariant(
                "approved_without_required_deliverables",
                len(missing_deliverables(db, item, node)),
                "agentic_strategy" if workflow.strategy_snapshot else None,
            )
            record_workflow_invariant(
                "approved_with_missing_dependencies",
                sum(
                    states[dependency] not in COMPLETED
                    for dependency in node.depends_on
                ),
                "agentic_strategy" if workflow.strategy_snapshot else None,
            )
        if action.action == "reject" and node.rework_to:
            record_workflow_invariant(
                "rework_target_not_activated",
                int(states[action.rework_to or node.rework_to] != "ready"),
                "agentic_strategy" if workflow.strategy_snapshot else None,
            )
    if commit and cancelled_runs:
        from app.services.loop_item_executions.cancellation import (
            request_execution_cancellations,
        )

        request_execution_cancellations(cancelled_runs)
    return item
