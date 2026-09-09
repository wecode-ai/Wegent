# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Deterministic workflow deliverable coverage checks."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import Delivery, LoopItemTaskBinding, loop_datetime_is_unset


def workflow_requirements(node: dict[str, Any]) -> list[dict[str, Any]]:
    values = node.get("required_deliverables")
    if not isinstance(values, list):
        return []
    return [dict(value) for value in values if isinstance(value, dict)]


def delivery_fulfillments(delivery: Delivery) -> list[dict[str, Any]]:
    metadata = (
        delivery.metadata_json if isinstance(delivery.metadata_json, dict) else {}
    )
    values = metadata.get("fulfillments")
    if not isinstance(values, list):
        return []
    return [dict(value) for value in values if isinstance(value, dict)]


def _node_delivery_ids(
    db: Session,
    loop_item_id: str,
    node: dict[str, Any],
) -> list[str]:
    """Return delivered deliveries whose source task belongs to this node.

    A workflow node may lose its persisted delivery link when the Delivery is
    finalized while the stage is still running. The source Task binding is the
    durable record of which stage produced the Delivery, so it can restore the
    coverage without relying on the snapshot link alone.
    """

    node_id = str(node.get("id") or "")
    if not node_id:
        return []
    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.loop_item_id == loop_item_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .all()
    )
    binding_ids = {
        str(binding.id) for binding in bindings if binding.workflow_node_id == node_id
    }
    if not binding_ids:
        return []
    deliveries = (
        db.query(Delivery)
        .filter(
            Delivery.loop_item_id == loop_item_id,
            Delivery.status == "delivered",
            Delivery.source_task_binding_id.in_(binding_ids),
        )
        .all()
    )
    return [str(delivery.id) for delivery in deliveries]


def fulfilled_requirement_ids(
    db: Session,
    node: dict[str, Any],
    loop_item_id: str | None = None,
) -> set[str]:
    delivery_ids = [
        str(value)
        for value in node.get("delivery_ids") or []
        if isinstance(value, str) and value
    ]
    if loop_item_id is not None:
        delivery_ids.extend(_node_delivery_ids(db, loop_item_id, node))
    if not delivery_ids:
        return set()
    deliveries = (
        db.query(Delivery)
        .filter(Delivery.id.in_(delivery_ids), Delivery.status == "delivered")
        .all()
    )
    return {
        str(fulfillment["requirement_id"])
        for delivery in deliveries
        for fulfillment in delivery_fulfillments(delivery)
        if fulfillment.get("requirement_id")
    }


def missing_requirement_ids(
    db: Session,
    node: dict[str, Any],
    loop_item_id: str | None = None,
) -> list[str]:
    fulfilled = fulfilled_requirement_ids(db, node, loop_item_id=loop_item_id)
    return [
        str(requirement["id"])
        for requirement in workflow_requirements(node)
        if requirement.get("id") and str(requirement["id"]) not in fulfilled
    ]
