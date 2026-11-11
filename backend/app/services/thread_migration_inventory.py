"""Read-only inventory for explicit Project-to-Group migration targets."""

import hashlib
import json
from collections import Counter
from dataclasses import asdict, dataclass

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CollaborationChatGroup,
    LoopItem,
    LoopNode,
    loop_datetime_value_is_unset,
)
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.cloud_project import CloudProjectBoardConfig
from app.services.chat_group_access import chat_group_members
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.collaboration_container_access import (
    require_collaboration_container_access,
)
from app.services.loop_items.access import item_security
from app.services.thread_participation import historical_participant_ids


@dataclass(frozen=True)
class ThreadMigrationObject:
    resource_id: str
    field: str
    key: str
    size_bytes: int | None
    sha256: str | None


@dataclass(frozen=True)
class ThreadMigrationEntry:
    thread_id: str
    version: int
    source_status: str | None
    target_status: str | None
    source_parent_id: str | None
    target_parent_id: str | None
    archived: bool
    eligible_participant_ids: tuple[int, ...]
    resource_counts: dict[str, int]
    objects: tuple[ThreadMigrationObject, ...]
    blockers: tuple[str, ...]

    @property
    def object_keys(self) -> tuple[str, ...]:
        return tuple(sorted({entry.key for entry in self.objects}))


@dataclass(frozen=True)
class ThreadMigrationInventory:
    source_project_id: str
    target_group_id: str
    source_version: int
    target_version: int
    target_next_item_number: int | None
    entries: tuple[ThreadMigrationEntry, ...]
    excluded_restricted_ids: tuple[str, ...]
    blockers: tuple[str, ...]

    @classmethod
    def from_dict(cls, value: dict[str, object]) -> "ThreadMigrationInventory":
        """Decode an operator report; fresh authorization remains mandatory."""
        data = dict(value)
        expected_digest = data.pop("inventory_id")
        entries = []
        for record in data.pop("entries"):
            entry = dict(record)
            entry["objects"] = tuple(
                ThreadMigrationObject(**item) for item in entry["objects"]
            )
            for field in ("blockers", "eligible_participant_ids"):
                entry[field] = tuple(entry[field])
            entries.append(ThreadMigrationEntry(**entry))
        data["entries"] = tuple(entries)
        for field in ("excluded_restricted_ids", "blockers"):
            data[field] = tuple(data[field])
        report = cls(**data)
        if report.to_dict()["inventory_id"] != expected_digest:
            raise ValueError("Migration inventory digest does not match its contents")
        return report

    def to_dict(self) -> dict[str, object]:
        value = asdict(self)
        # An inventory digest identifies this report, never permission to apply it.
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
        return {"inventory_id": hashlib.sha256(encoded.encode()).hexdigest(), **value}


def _resources(
    db: Session, item: LoopItem
) -> tuple[dict[str, int], tuple[ThreadMigrationObject, ...]]:
    direct = db.query(LoopNode).filter(LoopNode.loop_item_id == item.id).all()
    delivery_ids = [row.id for row in direct if row.resource_type == "delivery"]
    nested = (
        db.query(LoopNode).filter(LoopNode.delivery_id.in_(delivery_ids)).all()
        if delivery_ids
        else []
    )
    rows = {str(row.id): row for row in [*direct, *nested]}
    counts = Counter(row.resource_type for row in rows.values())
    objects = [
        ThreadMigrationObject(
            resource_id=str(row.id),
            field=field,
            key=getattr(row, field),
            size_bytes=row.size_bytes if field == "object_key" else None,
            sha256=row.sha256 if field == "object_key" else None,
        )
        for row in rows.values()
        if row.resource_type in {"attachment", "delivery", "delivery_asset"}
        for field in (
            "object_key",
            "markdown_object_key",
            "chat_object_key",
            "manifest_object_key",
        )
        if getattr(row, field)
    ]
    return dict(sorted(counts.items())), tuple(
        sorted(objects, key=lambda entry: (entry.key, entry.resource_id, entry.field))
    )


def _entry(
    db: Session,
    item: LoopItem,
    source_id: str,
    source_items: dict[str, LoopItem],
    public_ids: set[str],
    eligible: set[int],
    status_map: dict[str, str],
    statuses: set[str],
) -> ThreadMigrationEntry:
    blockers = []
    target_status = status_map.get(item.status or "", item.status)
    if target_status not in statuses:
        target_status = None
        blockers.append("explicit_status_mapping_required")
    parent = str(item.parent_id) if item.parent_id else None
    if parent and parent not in source_items:
        blockers.append("parent_outside_source_project")
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    if (
        item.assignee_agent_id
        or item.assignee_team_id
        or metadata.get("collaboration_group") is not None
    ):
        blockers.append("execution_resource_mapping_required")
    counts, objects = _resources(db, item)
    candidates = historical_participant_ids(db, item, source_container_id=source_id)
    return ThreadMigrationEntry(
        thread_id=str(item.id),
        version=item.version,
        source_status=item.status,
        target_status=target_status,
        source_parent_id=parent,
        target_parent_id=parent if parent in public_ids else None,
        archived=not loop_datetime_value_is_unset(item.deleted_at),
        eligible_participant_ids=tuple(sorted(candidates & eligible)),
        resource_counts=counts,
        objects=objects,
        blockers=tuple(blockers),
    )


def inspect_thread_migration(
    db: Session,
    *,
    source_project_id: int,
    target_group_id: int,
    actor_user_id: int,
    status_map: dict[str, str] | None = None,
) -> ThreadMigrationInventory:
    """Inventory persisted facts; never move records, copy objects or create grants.

    Execution-resource choices remain explicit blockers. Source visibility uses
    the existing Project permission service, including its archive restrictions.
    Restricted legacy records stay in their original project. A public child of
    an excluded restricted parent becomes a root instead of crossing containers.
    Object keys describe recorded references, not a verified copy manifest.
    """
    actor = db.get(User, actor_user_id)
    if actor is None or not actor.is_active:
        raise HTTPException(403, "An active migration actor is required")
    source = require_cloud_project_role(
        db, source_project_id, actor_user_id, BaseRole.Maintainer
    ).project
    target = require_collaboration_container_access(db, target_group_id, actor_user_id)
    if not isinstance(target.project, CollaborationChatGroup):
        raise HTTPException(422, "Migration target must be a group")
    if not has_permission(target.role, BaseRole.Maintainer):
        raise HTTPException(403, "Group management permission is required")
    statuses = {entry.id for entry in CloudProjectBoardConfig().statuses}
    mapping = status_map or {}
    if any(value not in statuses for value in mapping.values()):
        raise HTTPException(
            422, "Migration status mapping must use shared Thread states"
        )
    blockers = []
    if source.task_provider not in {"local", "backend"}:
        blockers.append("external_records_keep_provider_ownership")
    if target.project.status != "active":
        blockers.append("target_group_is_archived")
    if target.project.next_item_number is None or target.project.next_item_number < 1:
        blockers.append("target_counter_not_initialized")
    source_id = str(source.id)
    source_items = {
        str(row.id): row
        for row in db.query(LoopItem)
        .filter(LoopItem.cloud_project_id == source_id)
        .order_by(LoopItem.sequence_number, LoopItem.id)
        .all()
    }
    public_ids = {
        key
        for key, item in source_items.items()
        if item_security(item, source) == "open"
    }
    eligible = {
        member["user_id"] for member in chat_group_members(db, str(target.project.id))
    }
    entries = tuple(
        _entry(
            db, item, source_id, source_items, public_ids, eligible, mapping, statuses
        )
        for key, item in source_items.items()
        if key in public_ids
    )
    return ThreadMigrationInventory(
        source_project_id=source_id,
        target_group_id=str(target.project.id),
        source_version=source.version,
        target_version=target.project.version,
        target_next_item_number=target.project.next_item_number,
        entries=entries,
        excluded_restricted_ids=tuple(sorted(set(source_items) - public_ids)),
        blockers=tuple(blockers),
    )
