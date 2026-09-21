# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Durable Issue lifecycle intents for Executor-owned worktree cleanup."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import (
    LoopItem,
    LoopItemTaskBinding,
    WorkspaceCleanupIntent,
    loop_datetime_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution

STATUS_PENDING = "pending"
STATUS_EXECUTING = "executing"
STATUS_CANCELLED = "cancelled"
STATUS_ACKNOWLEDGED = "acknowledged"
EXECUTION_LEASE_SECONDS = 5 * 60


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _execution_target_by_runtime(
    db: Session,
    *,
    item_id: str,
) -> dict[tuple[int, str, str], str]:
    executions = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item_id,
            LoopItemExecution.executor_owner_user_id.isnot(None),
            LoopItemExecution.runtime_device_id != "",
            LoopItemExecution.runtime_task_id != "",
        )
        .order_by(LoopItemExecution.id.desc())
        .all()
    )
    targets: dict[tuple[int, str, str], str] = {}
    for execution in executions:
        owner_user_id = execution.executor_owner_user_id
        runtime_device_id = str(execution.runtime_device_id or "")
        runtime_task_id = str(execution.runtime_task_id or "")
        if not owner_user_id or not runtime_device_id or not runtime_task_id:
            continue
        key = (int(owner_user_id), runtime_device_id, runtime_task_id)
        targets.setdefault(
            key,
            str(execution.execution_device_id or runtime_device_id),
        )
    return targets


def sync_issue_status(
    db: Session,
    *,
    item: LoopItem,
    previous_status: str | None,
    next_status: str | None,
    next_version: int,
    completed_at: datetime | None,
) -> None:
    """Project an Issue close/reopen transition into per-Executor intents."""

    if previous_status == next_status:
        return
    existing = (
        db.query(WorkspaceCleanupIntent)
        .filter(WorkspaceCleanupIntent.loop_item_id == item.id)
        .all()
    )
    if next_status != "completed":
        for intent in existing:
            intent.status = STATUS_CANCELLED
            intent.version = next_version
            intent.due_at = None
            intent.completed_at = None
        return

    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.loop_item_id == item.id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            LoopItemTaskBinding.task_user_id.isnot(None),
            LoopItemTaskBinding.device_id.isnot(None),
            LoopItemTaskBinding.task_id.isnot(None),
        )
        .all()
    )
    targets = _execution_target_by_runtime(db, item_id=item.id)
    grouped: dict[tuple[int, str], dict[str, Any]] = defaultdict(
        lambda: {"task_ids": [], "execution_target_id": ""}
    )
    for binding in bindings:
        owner_user_id = int(binding.task_user_id)
        runtime_device_id = str(binding.device_id or "")
        runtime_task_id = str(binding.task_id or "")
        if not runtime_device_id or not runtime_task_id:
            continue
        group = grouped[(owner_user_id, runtime_device_id)]
        group["task_ids"].append(runtime_task_id)
        group["execution_target_id"] = targets.get(
            (owner_user_id, runtime_device_id, runtime_task_id),
            group["execution_target_id"] or runtime_device_id,
        )

    by_device = {
        (int(intent.task_user_id), str(intent.device_id or "")): intent
        for intent in existing
        if intent.task_user_id and intent.device_id
    }
    due_at = (completed_at or _utcnow()) + timedelta(
        days=settings.WORKTREE_CLEANUP_RETENTION_DAYS
    )
    for (owner_user_id, runtime_device_id), group in grouped.items():
        intent = by_device.get((owner_user_id, runtime_device_id))
        if intent is None:
            intent = WorkspaceCleanupIntent(
                cloud_project_id=item.cloud_project_id,
                loop_item_id=item.id,
                task_user_id=owner_user_id,
                device_id=runtime_device_id,
                created_by_user_id=item.created_by_user_id,
            )
            db.add(intent)
        intent.status = STATUS_PENDING
        intent.version = next_version
        intent.due_at = due_at
        intent.completed_at = None
        intent.metadata_json = {
            "runtime_task_ids": sorted(set(group["task_ids"])),
            "execution_target_id": group["execution_target_id"],
        }


def pull_due(
    db: Session,
    *,
    owner_user_id: int,
    runtime_device_id: str,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Return current due/cancelled intents without exposing worktree identity."""

    current_time = now or _utcnow()
    rows = (
        db.query(WorkspaceCleanupIntent)
        .filter(
            WorkspaceCleanupIntent.task_user_id == owner_user_id,
            WorkspaceCleanupIntent.device_id == runtime_device_id,
            WorkspaceCleanupIntent.status.in_(
                (STATUS_PENDING, STATUS_EXECUTING, STATUS_CANCELLED)
            ),
        )
        .order_by(
            WorkspaceCleanupIntent.updated_at.asc(), WorkspaceCleanupIntent.id.asc()
        )
        .all()
    )
    result: list[dict[str, Any]] = []
    for row in rows:
        if row.status in (STATUS_PENDING, STATUS_EXECUTING) and (
            row.due_at is None or row.due_at > current_time
        ):
            continue
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        task_ids = metadata.get("runtime_task_ids")
        result.append(
            {
                "intent_id": row.id,
                "issue_id": row.loop_item_id,
                "issue_version": row.version,
                "action": ("retain" if row.status == STATUS_CANCELLED else "release"),
                "runtime_task_ids": (
                    [str(value) for value in task_ids if str(value)]
                    if isinstance(task_ids, list)
                    else []
                ),
            }
        )
    return result


def claim(
    db: Session,
    *,
    owner_user_id: int,
    runtime_device_id: str,
    intent_id: str,
    issue_version: int,
    now: datetime | None = None,
) -> bool:
    """Linearize cleanup before the Executor starts deleting local state."""

    current_time = now or _utcnow()
    intent = (
        db.query(WorkspaceCleanupIntent)
        .filter(
            WorkspaceCleanupIntent.id == intent_id,
            WorkspaceCleanupIntent.task_user_id == owner_user_id,
            WorkspaceCleanupIntent.device_id == runtime_device_id,
            WorkspaceCleanupIntent.version == issue_version,
            WorkspaceCleanupIntent.status.in_((STATUS_PENDING, STATUS_EXECUTING)),
        )
        .with_for_update()
        .first()
    )
    if intent is None or intent.due_at is None or intent.due_at > current_time:
        return False
    intent.status = STATUS_EXECUTING
    intent.due_at = current_time + timedelta(seconds=EXECUTION_LEASE_SECONDS)
    db.commit()
    return True


def acknowledge(
    db: Session,
    *,
    owner_user_id: int,
    runtime_device_id: str,
    intent_id: str,
    issue_version: int,
) -> bool:
    """Acknowledge only the exact desired-state version the Executor applied."""

    intent = db.get(WorkspaceCleanupIntent, intent_id)
    if (
        intent is None
        or intent.task_user_id != owner_user_id
        or intent.device_id != runtime_device_id
        or intent.version != issue_version
        or intent.status not in (STATUS_EXECUTING, STATUS_CANCELLED)
    ):
        return False
    intent.status = STATUS_ACKNOWLEDGED
    intent.completed_at = _utcnow()
    db.commit()
    return True


def due_execution_targets(
    db: Session,
    *,
    now: datetime | None = None,
) -> list[tuple[int, str]]:
    """List owner/target pairs whose Executor should pull due cleanup work."""

    current_time = now or _utcnow()
    rows = (
        db.query(WorkspaceCleanupIntent)
        .filter(
            WorkspaceCleanupIntent.status.in_(
                (STATUS_PENDING, STATUS_EXECUTING, STATUS_CANCELLED)
            ),
        )
        .all()
    )
    targets: set[tuple[int, str]] = set()
    for row in rows:
        if not row.task_user_id:
            continue
        if row.status in (STATUS_PENDING, STATUS_EXECUTING) and (
            row.due_at is None or row.due_at > current_time
        ):
            continue
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        target = str(metadata.get("execution_target_id") or row.device_id or "")
        if target:
            targets.add((int(row.task_user_id), target))
    return sorted(targets)
