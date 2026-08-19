# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Deterministic workflow deliverable coverage checks."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import Delivery


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


def fulfilled_requirement_ids(db: Session, node: dict[str, Any]) -> set[str]:
    delivery_ids = [
        str(value)
        for value in node.get("delivery_ids") or []
        if isinstance(value, str) and value
    ]
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


def missing_requirement_ids(db: Session, node: dict[str, Any]) -> list[str]:
    fulfilled = fulfilled_requirement_ids(db, node)
    return [
        str(requirement["id"])
        for requirement in workflow_requirements(node)
        if requirement.get("id") and str(requirement["id"]) not in fulfilled
    ]
