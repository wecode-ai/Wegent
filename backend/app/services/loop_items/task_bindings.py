# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query active Runtime session bindings through their owner's device identity."""

from sqlalchemy import and_, false, or_
from sqlalchemy.orm import Query, Session

from app.models.delivery import LoopItemTaskBinding, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.services.device.identity import (
    owned_device_aliases,
    resolve_owned_device_alias,
)
from app.services.device.runtime_route import runtime_device_route_id
from app.services.loop_item_executions.cancellation import execution_cancellation_target
from app.services.runtime_cancellation import RuntimeCancellationTarget


def owned_binding_cancellation_targets(
    db: Session, *, project_id: int, item_ids: list[str], user_id: int
) -> list[RuntimeCancellationTarget]:
    """Capture actor-owned active bindings through trusted persisted devices."""

    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.cloud_project_id == project_id,
            LoopItemTaskBinding.loop_item_id.in_(item_ids),
            LoopItemTaskBinding.task_user_id == user_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            loop_datetime_is_unset(LoopItemTaskBinding.deleted_at),
        )
        .all()
    )
    targets = []
    for binding in bindings:
        device = resolve_owned_device_alias(
            db, user_id=user_id, device_id=binding.device_id or ""
        )
        if device is None or not binding.task_id:
            continue
        device_id = runtime_device_route_id(device)
        if device_id:
            targets.append(
                RuntimeCancellationTarget(
                    owner_user_id=user_id,
                    device_id=device_id,
                    task_id=binding.task_id,
                    runtime_device_id=binding.device_id,
                )
            )
    return targets


def uncovered_binding_cancellation_targets(
    db: Session,
    *,
    targets: list[RuntimeCancellationTarget],
    executions: list[LoopItemExecution],
) -> list[RuntimeCancellationTarget]:
    """Leave queue-owned Runtime addresses to their execution ACK mapping."""

    covered: set[tuple[int, str, str]] = set()
    for execution in executions:
        target = execution_cancellation_target(execution)
        if target is None:
            continue
        device = resolve_owned_device_alias(
            db, user_id=target.owner_user_id, device_id=target.device_id
        )
        if device is not None:
            covered.add(
                (target.owner_user_id, runtime_device_route_id(device), target.task_id)
            )
    return [target for target in targets if target.identity not in covered]


def active_task_binding_query(
    db: Session,
    *,
    device_id: str,
    task_id: str,
    user_id: int | None = None,
    project_id: str | int | None = None,
    item_id: str | None = None,
    lock: bool = False,
) -> Query[LoopItemTaskBinding]:
    """Keep identity expansion user-scoped, including shared project reads."""

    if user_id is None and (project_id is None or item_id is None):
        raise ValueError("An owner or exact project Issue scope is required")
    query = db.query(LoopItemTaskBinding).filter(
        LoopItemTaskBinding.task_id == task_id,
        loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        loop_datetime_is_unset(LoopItemTaskBinding.deleted_at),
    )
    if project_id is not None:
        query = query.filter(LoopItemTaskBinding.cloud_project_id == project_id)
    if item_id is not None:
        query = query.filter(LoopItemTaskBinding.loop_item_id == item_id)
    owners = (
        [user_id]
        if user_id is not None
        else [
            row[0]
            for row in query.with_entities(LoopItemTaskBinding.task_user_id).distinct()
        ]
    )
    matches = [
        and_(
            LoopItemTaskBinding.task_user_id == owner,
            LoopItemTaskBinding.device_id.in_(
                owned_device_aliases(db, user_id=owner, device_id=device_id)
            ),
        )
        for owner in owners
        if owner is not None
    ]
    query = query.filter(or_(*matches) if matches else false()).order_by(
        LoopItemTaskBinding.linked_at.desc(), LoopItemTaskBinding.id.desc()
    )
    return query.with_for_update() if lock else query
