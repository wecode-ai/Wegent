# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deterministic coordinator projections for readable collaboration strategies."""

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import (
    Delivery,
    LoopItem,
    LoopItemComment,
    loop_datetime_is_unset,
)
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.collaboration_strategy import (
    COORDINATOR_EVIDENCE_LIMIT,
    CoordinatorDecision,
)
from app.schemas.issue_workflow import IssueWorkflowInstance, WorkflowAction


def comment_evidence_refs(
    db: Session, item: LoopItem, *, limit: int | None = None
) -> list[str]:
    chat_ids = (
        db.query(ProjectChatMessage.created_at, ProjectChatMessage.message_id)
        .filter_by(project_id=str(item.cloud_project_id), task_id=item.id)
        .filter(loop_datetime_is_unset(ProjectChatMessage.deleted_at))
        .order_by(ProjectChatMessage.created_at.desc(), ProjectChatMessage.id.desc())
    )
    issue_ids = (
        db.query(LoopItemComment.created_at, LoopItemComment.id)
        .filter_by(
            cloud_project_id=item.cloud_project_id,
            loop_item_id=item.id,
            status="active",
        )
        .filter(loop_datetime_is_unset(LoopItemComment.deleted_at))
        .order_by(LoopItemComment.created_at.desc(), LoopItemComment.id.desc())
    )
    rows = [
        (created_at or datetime.min, f"comment:{value}")
        for query in (chat_ids, issue_ids)
        for created_at, value in (query.limit(limit) if limit else query)
    ]
    rows.sort(reverse=True)
    return [ref for _, ref in (rows[:limit] if limit else rows)]


def coordinator_check(
    db: Session, item: LoopItem, workflow: IssueWorkflowInstance, action: WorkflowAction
) -> CoordinatorDecision:
    from app.services.loop_items.strategy import (
        INTAKE_LABELS,
        _workflow_owner_label,
        intake_missing,
    )
    from app.services.loop_items.strategy_reviews import missing_stage_conditions
    from app.services.loop_items.workflow import missing_deliverables

    if workflow.strategy_state == "active" and workflow.current_stage_id is None:
        raise HTTPException(409, "Completed strategies have no next stage to evaluate")
    stage = workflow.current_stage_id or "inbox"
    current = next((node for node in workflow.nodes if node.id == stage), None)
    missing = (
        [entry["name"] for entry in missing_deliverables(db, item, current)]
        if current
        else [INTAKE_LABELS[key] for key in intake_missing(item)]
    )
    if current is not None:
        missing.extend(missing_stage_conditions(workflow, current, item.version))
    delivery_budget = (COORDINATOR_EVIDENCE_LIMIT - 2) // 2
    deliveries = (
        db.query(Delivery)
        .filter(Delivery.loop_item_id == item.id, Delivery.status == "delivered")
        .order_by(Delivery.created_at.desc(), Delivery.id.desc())
        .limit(delivery_budget)
        .all()
    )
    evidence = [
        f"strategy:{workflow.strategy_snapshot.version}",
        f"issue:{item.id}:{item.version}",
        *[f"delivery:{delivery.id}" for delivery in deliveries],
    ]
    evidence.extend(
        comment_evidence_refs(
            db, item, limit=COORDINATOR_EVIDENCE_LIMIT - len(evidence)
        )
    )
    owner = _workflow_owner_label(db, current)
    fulfilled = (
        [
            entry.name
            for entry in current.required_deliverables
            if entry.name not in missing
        ]
        if current
        else [
            label
            for key, label in INTAKE_LABELS.items()
            if key not in intake_missing(item)
        ]
    )
    return CoordinatorDecision(
        strategy_version=workflow.strategy_snapshot.version,
        issue_version=item.version,
        stage=stage,
        next_owner=owner
        or (item.metadata_json or {})
        .get("intake_definition", {})
        .get("proposed_owner"),
        next_action=(
            "补齐缺失条件并请求人工确认" if missing else "请求有权限的人确认阶段推进"
        ),
        satisfied_conditions=fulfilled,
        missing_conditions=missing,
        evidence_refs=evidence,
        clarification=(f"请补齐：{'、'.join(missing)}" if missing else None),
        idempotency_key=action.idempotency_key,
        integration_status="recorded",
    )


def validate_coordinator_decision(
    db: Session,
    item: LoopItem,
    workflow: IssueWorkflowInstance,
    decision: CoordinatorDecision,
) -> None:
    if (
        decision.strategy_version != workflow.strategy_snapshot.version
        or decision.issue_version != item.version
    ):
        raise HTTPException(409, {"code": "coordinator_version_conflict"})
    if decision.stage != (workflow.current_stage_id or "inbox"):
        raise HTTPException(409, {"code": "coordinator_stage_conflict"})
    valid = {
        f"strategy:{workflow.strategy_snapshot.version}",
        f"issue:{item.id}:{item.version}",
    }
    valid.update(
        f"delivery:{row.id}"
        for row in db.query(Delivery)
        .filter(Delivery.loop_item_id == item.id, Delivery.status == "delivered")
        .all()
    )
    valid.update(comment_evidence_refs(db, item))
    if not set(decision.evidence_refs) <= valid:
        raise HTTPException(422, {"code": "coordinator_evidence_invalid"})


def refresh_strategy_coordinator(
    db: Session, item: LoopItem, event: str, event_key: str
) -> bool:
    """Re-evaluate coordinator context after a scoped Issue event."""
    from app.services.loop_items.workflow import workflow_snapshot

    workflow = workflow_snapshot(item)
    if not workflow or not workflow.strategy_snapshot:
        return False
    if not settings.COLLAB_AGENTIC_STRATEGY_V1:
        return True
    if workflow.strategy_state == "active" and workflow.current_stage_id is None:
        return True
    if (
        workflow.coordinator_trigger
        and workflow.coordinator_trigger.get("event_key") == event_key
    ):
        return True
    db.flush()
    action = WorkflowAction(type="evaluate", idempotency_key=event_key)
    workflow.coordinator_decision = coordinator_check(db, item, workflow, action)
    workflow.coordinator_trigger = {
        "event": event,
        "event_key": event_key,
        "integration_status": "recorded",
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": workflow.model_dump(mode="json"),
    }
    return True
