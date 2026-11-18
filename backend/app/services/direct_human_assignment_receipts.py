"""Public receipts projected from assignment, Runtime and Delivery facts."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from sqlalchemy import and_
from sqlalchemy.orm import Session, aliased

from app.core.cache import cache_manager
from app.db.timezone import database_datetime_as_utc
from app.models.delivery import (
    Delivery,
    LoopItem,
    LoopItemTaskBinding,
    loop_datetime_is_unset,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.services.collaboration_human_assignments import direct_human_assignment_id
from app.services.device.identity import (
    device_connection_route_id,
    matching_online_info,
    resolve_owned_device_alias,
)
from app.services.device.local_provider import LocalDeviceProvider
from app.services.human_assistant_dispatch import (
    device_role,
    dispatch_resources,
    enabled,
)

if TYPE_CHECKING:
    from app.services.issue_assignments import AssignmentEvent

logger = logging.getLogger(__name__)


def online_endpoints(devices: list[Kind]) -> dict[int, bool | None]:
    if not devices:
        return {}
    keys = {
        device.id: LocalDeviceProvider.generate_online_key(
            device.user_id, device_connection_route_id(device)
        )
        for device in devices
    }
    try:
        documents = cache_manager.mget_sync_or_raise(list(dict.fromkeys(keys.values())))
    except Exception:
        logger.warning(
            "Personal assistant device presence is unavailable", exc_info=True
        )
        return {device.id: None for device in devices}
    result = {}
    for device in devices:
        spec = (device.json or {}).get("spec", {})
        online = matching_online_info(spec, documents.get(keys[device.id]))
        result[device.id] = bool(
            online and online.get("status", "online") in {"online", "busy"}
        )
    return result


def current_receipts(
    db: Session,
    items: list[LoopItem],
    *,
    assignments: dict[str, list[AssignmentEvent]],
    executions: dict[str, LoopItemExecution],
) -> dict[str, dict]:
    if not enabled():
        return {}
    dispatches, executions = dispatch_resources(
        db, items, assignments=assignments, executions=executions
    )
    receipts = {
        item_id: _receipt(
            db, dispatch, executions.get(str(dispatch.get("executionId")))
        )
        for item_id, dispatch in dispatches.items()
    }
    _pending_availability(db, receipts, executions, {item.id: item for item in items})
    candidates = {
        item.id: receipts[item.id]
        for item in items
        if item.id in receipts
        and (
            receipts[item.id]["runtimeTaskId"]
            or item.current_delivery_id
            or any(
                event.metadata.get("stand_in_received_at")
                for event in assignments[item.id]
            )
        )
    }
    _project_bindings_and_deliveries(db, candidates, assignments)
    return receipts


def _pending_availability(
    db: Session,
    receipts: dict[str, dict],
    executions: dict[str, LoopItemExecution],
    items: dict[str, LoopItem],
) -> None:
    pending = {
        item_id: executions[str(receipt["executionId"])]
        for item_id, receipt in receipts.items()
        if receipt.get("executionId")
        and str(receipt["executionId"]) in executions
        and executions[str(receipt["executionId"])].status == "waiting_runtime"
        and receipt["state"] in {"queued", "waiting_device"}
    }
    if not pending:
        return
    owners = {execution.executor_owner_user_id for execution in pending.values()}
    devices = (
        db.query(Kind)
        .filter(
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active.is_(True),
            Kind.user_id.in_(owners),
        )
        .all()
    )
    online = online_endpoints(devices)
    for item_id, execution in pending.items():
        device = resolve_owned_device_alias(
            db,
            user_id=execution.executor_owner_user_id,
            device_id=execution.execution_device_id,
        )
        role, reason = (
            device_role(device, items[item_id])
            if device
            else (None, "no_authorized_assistant")
        )
        if role is None:
            receipts[item_id].update(state="blocked_policy", reasonCode=reason)
            continue
        ready = online.get(device.id)
        receipts[item_id].update(
            state="queued" if ready else "waiting_device",
            reasonCode=(
                None
                if ready
                else ("device_state_unavailable" if ready is None else "waiting_device")
            ),
        )


def _receipt(db: Session, dispatch: dict, execution: LoopItemExecution | None) -> dict:
    state = dispatch["dispatchState"]
    reason = dispatch.get("reasonCode")
    runtime_task = None
    updated = dispatch["updatedAt"]
    if execution is not None:
        runtime_task = execution.runtime_task_id or None
        if execution.status != "waiting_runtime":
            state = {
                "claimed": "running",
                "cancel_requested": "cancelling",
                "pending_approval": "waiting_user",
            }.get(execution.status, execution.status)
            if (
                execution.observed_state in {"waiting_user", "requires_action"}
                and state == "running"
            ):
                state = "waiting_user"
            reason = (
                None
                if state in {"running", "waiting_user", "completed"}
                else execution.termination_reason or reason
            )
            if execution.status == "cancel_requested":
                reason = execution.termination_reason or "cancel_requested"
            updated = database_datetime_as_utc(db, execution.updated_at).isoformat()
    if state == "no_authorized_assistant":
        state = "blocked_policy"
    return {
        "projectId": dispatch["projectId"],
        "issueId": dispatch["issueId"],
        "humanAssignmentId": direct_human_assignment_id(
            issue_id=dispatch["issueId"], assignment_id=dispatch["assignmentId"]
        ),
        "ownerUserId": dispatch["ownerUserId"],
        "state": state,
        "reasonCode": reason,
        "runtimeTaskId": runtime_task,
        "deliveryId": None,
        "updatedAt": updated,
        "dispatchId": dispatch["dispatchId"],
        "assignmentId": dispatch["assignmentId"],
        "executionId": dispatch.get("executionId"),
        "assignmentVersion": dispatch["assignmentVersion"],
        "createdAt": dispatch["createdAt"],
    }


def _project_bindings_and_deliveries(
    db: Session,
    receipts: dict[str, dict],
    assignments: dict[str, list[AssignmentEvent]],
) -> None:
    if not receipts:
        return
    # A single batch retains real, owner-scoped source references, including a
    # completed Delivery whose source task was subsequently unlinked.
    delivery_row = aliased(Delivery)
    rows = (
        db.query(LoopItemTaskBinding, delivery_row)
        .outerjoin(
            delivery_row,
            and_(
                delivery_row.source_task_binding_id == LoopItemTaskBinding.id,
                delivery_row.status == "delivered",
                loop_datetime_is_unset(delivery_row.deleted_at),
            ),
        )
        .filter(
            LoopItemTaskBinding.loop_item_id.in_(receipts),
            loop_datetime_is_unset(LoopItemTaskBinding.deleted_at),
        )
        .order_by(
            delivery_row.delivered_at.desc(), LoopItemTaskBinding.linked_at.desc()
        )
    )
    delivered = set()
    for binding, delivery in rows:
        receipt = receipts[binding.loop_item_id]
        if not _binding_matches(binding, receipt):
            continue
        received = any(
            event.id == receipt["assignmentId"]
            and event.metadata.get("stand_in_received_at")
            for event in assignments[binding.loop_item_id]
        )
        if received and receipt["state"] in {"queued", "waiting_device"}:
            receipt.update(
                state="running", reasonCode=None, runtimeTaskId=binding.task_id
            )
        if binding.loop_item_id not in delivered and _delivery_matches(
            delivery, receipt
        ):
            if receipt["state"] not in {"cancelling", "cancelled", "superseded"}:
                receipt.update(
                    state="completed",
                    reasonCode=None,
                    deliveryId=str(delivery.id),
                    runtimeTaskId=binding.task_id,
                    updatedAt=database_datetime_as_utc(
                        db, delivery.delivered_at or delivery.updated_at
                    ).isoformat(),
                )
            delivered.add(binding.loop_item_id)


def _binding_matches(binding: LoopItemTaskBinding, receipt: dict) -> bool:
    metadata = binding.metadata_json or {}
    return (
        binding.task_user_id == receipt["ownerUserId"]
        and str(binding.cloud_project_id) == receipt["projectId"]
        and metadata.get("human_assignment_id") == receipt["humanAssignmentId"]
        and metadata.get("assignment_id") == receipt["assignmentId"]
    )


def _delivery_matches(delivery: Delivery | None, receipt: dict) -> bool:
    if delivery is None:
        return False
    snapshot = delivery.source_task_snapshot or {}
    return (
        str(delivery.cloud_project_id) == receipt["projectId"]
        and delivery.loop_item_id == receipt["issueId"]
        and snapshot.get("humanAssignmentId") == receipt["humanAssignmentId"]
        and snapshot.get("assignmentId") == receipt["assignmentId"]
        and snapshot.get("userId") == receipt["ownerUserId"]
    )
