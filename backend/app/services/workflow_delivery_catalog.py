# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Describe existing Issue deliverables without expanding their content."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import Delivery, LoopItemTaskBinding, loop_datetime_is_unset
from app.services.workflow_deliverables import (
    delivery_fulfillments,
    workflow_requirements,
)
from shared.telemetry.decorators import trace_sync


def _entries(delivery: Delivery, stage: dict[str, Any]) -> list[dict[str, Any]]:
    requirements = {value["id"]: value for value in workflow_requirements(stage)}
    submitted_at = delivery.delivered_at or delivery.created_at
    base = {
        "delivery_id": str(delivery.id),
        "stage_id": stage.get("id"),
        "stage_name": stage.get("name"),
        "submitted_at": submitted_at.isoformat() if submitted_at else None,
    }
    entries = []
    for fulfillment in delivery_fulfillments(delivery):
        requirement_id = fulfillment.get("requirement_id")
        requirement = requirements.get(requirement_id, {})
        entries.append(
            {
                **base,
                "requirement_id": requirement_id,
                "name": requirement.get("name") or requirement_id or delivery.id,
                "type": fulfillment.get("kind") or requirement.get("value_type"),
            }
        )
    return entries or [
        {
            **base,
            "requirement_id": None,
            "name": delivery.title or delivery.display_name or str(delivery.id),
            "type": "delivery",
        }
    ]


@trace_sync(span_name="workflow.delivery_catalog", tracer_name="backend.workflow")
def workflow_delivery_catalog(
    db: Session, *, item_id: str, nodes: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    # Source bindings preserve provenance even after tasks are unlinked. A stage
    # link can supply provenance for deliveries submitted without a task binding.
    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(LoopItemTaskBinding.loop_item_id == item_id)
        .all()
    )
    binding_stages = {binding.id: binding.workflow_node_id for binding in bindings}
    delivery_stages = {
        delivery_id: node_id
        for node_id, node in nodes.items()
        for delivery_id in node.get("delivery_ids") or []
    }
    deliveries = (
        db.query(Delivery)
        .filter(
            Delivery.loop_item_id == item_id,
            Delivery.status == "delivered",
            loop_datetime_is_unset(Delivery.deleted_at),
        )
        .order_by(Delivery.delivered_at, Delivery.created_at, Delivery.id)
        .all()
    )
    catalog = []
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for delivery in deliveries:
        stage_id = binding_stages.get(delivery.source_task_binding_id)
        stage_id = stage_id or delivery_stages.get(delivery.id)
        for entry in _entries(delivery, nodes.get(stage_id, {"id": stage_id})):
            catalog.append(entry)
            if stage_id and entry["requirement_id"]:
                latest[(stage_id, entry["requirement_id"])] = entry
    for entry in catalog:
        current = latest.get((entry["stage_id"], entry["requirement_id"]), entry)
        entry["superseded_by_delivery_id"] = (
            current["delivery_id"]
            if current["delivery_id"] != entry["delivery_id"]
            else None
        )
    return catalog
