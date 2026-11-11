"""Atomic, forward-only transfer of explicitly inventoried public Threads."""

import hashlib
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.delivery import (
    CloudProject,
    CollaborationChatGroup,
    LoopItem,
    LoopNode,
    ThreadMigrationCheckpoint,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.services.chat_group_access import chat_group_members
from app.services.collaboration_container_access import (
    require_collaboration_container_access,
)
from app.services.delivery.storage import DeliveryStorage, delivery_storage
from app.services.project_classification_access import require_classification_project
from app.services.thread_migration_assets import (
    ThreadMigrationAssets,
    require_current_inventory,
    require_migration_asset_receipts,
)
from app.services.thread_migration_history import migrate_thread_history
from app.services.thread_migration_inventory import ThreadMigrationInventory
from app.services.thread_participation import initialize_historical_participants
from app.services.thread_project_links import create_thread_classification

# These records are recipient-owned historical execution inputs, not public chat.
PRIVATE_HISTORY_TYPES = frozenset(
    {
        "stand_in_issue_inbox",
        "stand_in_issue_event",
        "automation_run",
        "workflow_run",
        "workflow_plan_item",
        "workspace_cleanup",
    }
)
PUBLIC_RESOURCE_TYPES = frozenset(
    {"comment", "attachment", "delivery", "delivery_asset", "execution", "collaborator"}
)


@dataclass(frozen=True)
class ThreadMigrationResult:
    checkpoint_id: str
    thread_ids: tuple[str, ...]
    replayed: bool


def _checkpoint_id(inventory: ThreadMigrationInventory, retain_project: bool) -> str:
    identity = (
        f"thread-migration:{inventory.to_dict()['inventory_id']}:{retain_project}"
    )
    return str(
        int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8], "big") >> 1
    )


def _lock_authority(
    db: Session, inventory: ThreadMigrationInventory, actor: int
) -> tuple[CollaborationChatGroup, CloudProject]:
    group = (
        db.query(CollaborationChatGroup)
        .filter(CollaborationChatGroup.id == inventory.target_group_id)
        .with_for_update()
        .populate_existing()
        .one_or_none()
    )
    if group is None:
        raise HTTPException(404, "Chat group not found")
    # Match message writers: group, grants, all granted accounts in numeric order.
    chat_group_members(db, str(group.id), lock=True)
    require_collaboration_container_access(
        db, group.id, actor, BaseRole.Maintainer, write=True
    )
    project = require_classification_project(
        db, inventory.source_project_id, actor, required_role=BaseRole.Maintainer
    )
    return group, project


def _require_idle(
    session_factory: Callable[[], AbstractContextManager[Session]],
    thread_ids: tuple[str, ...],
) -> None:
    if not thread_ids:
        return
    # A fresh read sees admissions committed before our Thread locks, even on RR.
    # Do not lock executions here: completion can hold execution then Thread.
    with session_factory() as current:
        active = (
            current.query(LoopItemExecution.id)
            .filter(
                LoopItemExecution.loop_item_id.in_(thread_ids),
                LoopItemExecution.status.notin_({"completed", "failed", "cancelled"}),
            )
            .first()
        )
        streaming = (
            current.query(ProjectChatMessage.id)
            .filter(
                ProjectChatMessage.task_id.in_(thread_ids),
                ProjectChatMessage.status.in_({"pending", "streaming"}),
            )
            .first()
        )
        if active or streaming:
            raise HTTPException(409, "Finish active Thread execution before migration")


def _preserve_time(row: LoopNode) -> None:
    flag_modified(row, "updated_at")


def _move_execution_history(
    db: Session, inventory: ThreadMigrationInventory, ids: tuple[str, ...]
) -> None:
    # Admission shares the Thread mutex; active runs were checked separately.
    # Only terminal history moves. Its immutable private origin stays intact.
    # A losing terminal callback does not project another Thread update.
    db.query(LoopItemExecution).filter(
        LoopItemExecution.loop_item_id.in_(ids),
        LoopItemExecution.cloud_project_id == inventory.source_project_id,
        LoopItemExecution.status.in_({"completed", "failed", "cancelled"}),
    ).update(
        {
            LoopItemExecution.cloud_project_id: inventory.target_group_id,
            LoopItemExecution.updated_at: LoopItemExecution.updated_at,
        },
        synchronize_session=False,
    )


def _move_resources(
    db: Session,
    inventory: ThreadMigrationInventory,
    ids: tuple[str, ...],
    assets: ThreadMigrationAssets,
) -> None:
    direct = db.query(LoopNode).filter(LoopNode.loop_item_id.in_(ids)).all()
    deliveries = [row.id for row in direct if row.resource_type == "delivery"]
    nested = (
        db.query(LoopNode).filter(LoopNode.delivery_id.in_(deliveries)).all()
        if deliveries
        else []
    )
    indexes = (
        db.query(LoopNode)
        .filter(
            LoopNode.parent_id.in_(ids), LoopNode.resource_type == "assignment_index"
        )
        .all()
    )
    rows = {str(row.id): row for row in [*direct, *nested, *indexes]}
    references = {
        (obj.resource_id, obj.field): obj
        for entry in inventory.entries
        for obj in entry.objects
    }
    copies = {copy.source_key: copy.target_key for copy in assets.objects}
    for row in rows.values():
        if row.resource_type in PRIVATE_HISTORY_TYPES | {"thread_project_link"}:
            continue
        if row.resource_type not in PUBLIC_RESOURCE_TYPES | {"assignment_index"}:
            raise HTTPException(
                409, "Linked resource requires an explicit migration rule"
            )
        if row.cloud_project_id not in (None, "", "0", inventory.source_project_id):
            raise HTTPException(409, "Linked resource belongs to another container")
        row.cloud_project_id = inventory.target_group_id
        for field in (
            "object_key",
            "markdown_object_key",
            "chat_object_key",
            "manifest_object_key",
        ):
            reference = references.get((str(row.id), field))
            if reference:
                if getattr(row, field) != reference.key:
                    raise HTTPException(409, "Migration object references changed")
                setattr(row, field, copies[reference.key])
        _preserve_time(row)
    _move_execution_history(db, inventory, ids)


def _move_threads(
    db: Session,
    inventory: ThreadMigrationInventory,
    group: CollaborationChatGroup,
    project: CloudProject,
    assets: ThreadMigrationAssets,
    retain_project: bool,
) -> None:
    entries = {entry.thread_id: entry for entry in inventory.entries}
    for thread_id, entry in entries.items():
        thread = db.get(LoopItem, thread_id)
        thread.cloud_project_id = group.id
        thread.parent_id = entry.target_parent_id
        thread.sequence_number = group.next_item_number
        group.next_item_number += 1
        thread.status = entry.target_status
        thread.version += 1
        _preserve_time(thread)
        # Read source authors before public history changes its container.
        initialize_historical_participants(
            db, thread, source_container_id=inventory.source_project_id
        )
        if retain_project:
            create_thread_classification(db, thread, project)
        elif (thread.metadata_json or {}).get("milestone_id"):
            thread.metadata_json = {
                key: value
                for key, value in thread.metadata_json.items()
                if key != "milestone_id"
            }
    # Excluded private records stay private and cannot retain a foreign parent.
    for row in db.query(LoopItem).filter(
        LoopItem.cloud_project_id == inventory.source_project_id,
        LoopItem.parent_id.in_(tuple(entries)),
    ):
        row.parent_id = None
        row.version += 1
        _preserve_time(row)
    migrate_thread_history(
        db,
        source_id=inventory.source_project_id,
        group_id=str(group.id),
        thread_ids=tuple(entries),
    )
    _move_resources(db, inventory, tuple(entries), assets)


def apply_thread_migration(
    *,
    inventory: ThreadMigrationInventory,
    assets: ThreadMigrationAssets,
    actor_user_id: int,
    retain_source_project: bool,
    session_factory: Callable[[], AbstractContextManager[Session]],
    storage: DeliveryStorage = delivery_storage,
) -> ThreadMigrationResult:
    """Commit one explicit plan, or leave all database ownership unchanged.

    No target membership, private context, source blobs or source project is
    created/deleted. Retaining project classification is an explicit plan input.
    Already committed retries recheck management authority and never replay edits.
    """
    checkpoint_id = _checkpoint_id(inventory, retain_source_project)
    ids = tuple(entry.thread_id for entry in inventory.entries)
    with session_factory() as db, db.begin():
        group, project = _lock_authority(db, inventory, actor_user_id)
        db.query(LoopItem).filter(
            or_(
                LoopItem.cloud_project_id == project.id,
                LoopItem.id.in_(ids),
            )
        ).order_by(LoopItem.id).with_for_update().populate_existing().all()
        # First consistent read must follow the Thread mutexes. On RR, reading
        # even a missing checkpoint earlier would freeze stale resource facts.
        checkpoint = db.get(LoopNode, checkpoint_id)
        if checkpoint is not None:
            if (
                not isinstance(checkpoint, ThreadMigrationCheckpoint)
                or checkpoint.parent_id != group.id
                or checkpoint.cloud_project_id != project.id
                or checkpoint.status != "completed"
                or checkpoint.metadata_json
                != {
                    "inventory_id": inventory.to_dict()["inventory_id"],
                    "thread_ids": list(ids),
                    "retain_source_project": retain_source_project,
                }
            ):
                raise HTTPException(409, "Migration checkpoint identity collision")
            return ThreadMigrationResult(checkpoint_id, ids, True)
        require_current_inventory(db, inventory, actor_user_id)
        _require_idle(session_factory, ids)
        require_migration_asset_receipts(db, inventory, assets, storage)
        _move_threads(db, inventory, group, project, assets, retain_source_project)
        group.version += 1
        db.add(
            ThreadMigrationCheckpoint(
                id=checkpoint_id,
                parent_id=group.id,
                cloud_project_id=project.id,
                status="completed",
                created_by_user_id=actor_user_id,
                metadata_json={
                    "inventory_id": inventory.to_dict()["inventory_id"],
                    "thread_ids": list(ids),
                    "retain_source_project": retain_source_project,
                },
            )
        )
        db.flush()
    return ThreadMigrationResult(checkpoint_id, ids, False)
