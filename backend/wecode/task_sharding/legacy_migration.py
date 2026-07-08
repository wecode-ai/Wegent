from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from sqlalchemy.orm import Session

from app.models.subtask import Subtask
from app.models.task import TaskResource
from wecode.task_sharding.shard import subtask_model_for_owner, task_model_for_user
from wecode.task_sharding.task_id import is_new_task_id


@dataclass(frozen=True)
class LegacyTaskShardMigrationResult:
    tasks_seen: int = 0
    tasks_copied: int = 0
    subtasks_seen: int = 0
    subtasks_copied: int = 0
    orphan_subtasks: int = 0

    def merge(self, other: "LegacyTaskShardMigrationResult"):
        return LegacyTaskShardMigrationResult(
            tasks_seen=self.tasks_seen + other.tasks_seen,
            tasks_copied=self.tasks_copied + other.tasks_copied,
            subtasks_seen=self.subtasks_seen + other.subtasks_seen,
            subtasks_copied=self.subtasks_copied + other.subtasks_copied,
            orphan_subtasks=self.orphan_subtasks + other.orphan_subtasks,
        )


@dataclass(frozen=True)
class LegacyShardComparisonIssue:
    row_type: str
    row_id: int
    user_id: int | None
    task_id: int | None
    issue: str
    fields: tuple[str, ...] = ()


@dataclass(frozen=True)
class LegacyTaskShardComparisonResult:
    legacy_tasks: int = 0
    missing_tasks: int = 0
    mismatched_tasks: int = 0
    legacy_subtasks: int = 0
    missing_subtasks: int = 0
    mismatched_subtasks: int = 0
    orphan_subtasks: int = 0
    details: tuple[LegacyShardComparisonIssue, ...] = ()

    def merge(self, other: "LegacyTaskShardComparisonResult"):
        return LegacyTaskShardComparisonResult(
            legacy_tasks=self.legacy_tasks + other.legacy_tasks,
            missing_tasks=self.missing_tasks + other.missing_tasks,
            mismatched_tasks=self.mismatched_tasks + other.mismatched_tasks,
            legacy_subtasks=self.legacy_subtasks + other.legacy_subtasks,
            missing_subtasks=self.missing_subtasks + other.missing_subtasks,
            mismatched_subtasks=self.mismatched_subtasks + other.mismatched_subtasks,
            orphan_subtasks=self.orphan_subtasks + other.orphan_subtasks,
            details=(*self.details, *other.details),
        )

    @property
    def ok(self) -> bool:
        return (
            self.missing_tasks == 0
            and self.mismatched_tasks == 0
            and self.missing_subtasks == 0
            and self.mismatched_subtasks == 0
            and self.orphan_subtasks == 0
        )


def migrate_legacy_task_shards(
    db: Session,
    *,
    batch_size: int = 500,
    dry_run: bool = True,
    user_id: int | None = None,
) -> LegacyTaskShardMigrationResult:
    """Copy legacy tasks/subtasks into owner hash shards.

    The legacy `tasks` and `subtasks` rows are intentionally kept as routing indexes.
    Re-running this function is safe: existing shard rows are skipped.
    """
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")

    result = LegacyTaskShardMigrationResult()
    for batch in _iter_task_batches(db, batch_size=batch_size, user_id=user_id):
        result = result.merge(_copy_task_batch(db, batch, dry_run=dry_run))
        if not dry_run:
            db.flush()

    owner_cache: dict[int, int | None] = {}
    for batch in _iter_subtask_batches(db, batch_size=batch_size, user_id=user_id):
        result = result.merge(
            _copy_subtask_batch(
                db,
                batch,
                owner_cache=owner_cache,
                dry_run=dry_run,
            )
        )
        if not dry_run:
            db.flush()

    return result


def compare_legacy_task_shards(
    db: Session,
    *,
    batch_size: int = 500,
    user_id: int | None = None,
    ignore_task_fields: tuple[str, ...] = (),
) -> LegacyTaskShardComparisonResult:
    """Compare legacy task/subtask rows with their owner shard copies."""
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")

    result = LegacyTaskShardComparisonResult()
    for batch in _iter_task_batches(db, batch_size=batch_size, user_id=user_id):
        result = result.merge(
            _compare_task_batch(
                db,
                batch,
                ignore_fields=frozenset(ignore_task_fields),
            )
        )

    owner_cache: dict[int, int | None] = {}
    for batch in _iter_subtask_batches(db, batch_size=batch_size, user_id=user_id):
        result = result.merge(
            _compare_subtask_batch(db, batch, owner_cache=owner_cache)
        )

    return result


def _iter_task_batches(
    db: Session,
    *,
    batch_size: int,
    user_id: int | None,
) -> Iterable[list[TaskResource]]:
    last_id = 0
    while True:
        query = db.query(TaskResource).filter(TaskResource.id > last_id)
        if user_id is not None:
            query = query.filter(TaskResource.user_id == user_id)
        rows = query.order_by(TaskResource.id.asc()).limit(batch_size).all()
        if not rows:
            return
        yield [row for row in rows if not is_new_task_id(row.id)]
        last_id = rows[-1].id


def _iter_subtask_batches(
    db: Session,
    *,
    batch_size: int,
    user_id: int | None,
) -> Iterable[list[Subtask]]:
    last_id = 0
    while True:
        query = db.query(Subtask).filter(Subtask.id > last_id)
        if user_id is not None:
            query = query.join(TaskResource, Subtask.task_id == TaskResource.id).filter(
                TaskResource.user_id == user_id
            )
        rows = query.order_by(Subtask.id.asc()).limit(batch_size).all()
        if not rows:
            return
        yield [row for row in rows if not is_new_task_id(row.id)]
        last_id = rows[-1].id


def _copy_task_batch(
    db: Session,
    tasks: list[TaskResource],
    *,
    dry_run: bool,
) -> LegacyTaskShardMigrationResult:
    copied = 0
    for task in tasks:
        model = task_model_for_user(task.user_id)
        if db.query(model.id).filter(model.id == task.id).first() is not None:
            continue
        copied += 1
        if not dry_run:
            db.add(model(**_model_values(task, TaskResource)))
    return LegacyTaskShardMigrationResult(tasks_seen=len(tasks), tasks_copied=copied)


def _compare_task_batch(
    db: Session,
    tasks: list[TaskResource],
    *,
    ignore_fields: frozenset[str] = frozenset(),
) -> LegacyTaskShardComparisonResult:
    missing = 0
    mismatched = 0
    details: list[LegacyShardComparisonIssue] = []
    for task in tasks:
        model = task_model_for_user(task.user_id)
        shard_task = db.query(model).filter(model.id == task.id).first()
        if shard_task is None:
            missing += 1
            details.append(
                LegacyShardComparisonIssue(
                    row_type="task",
                    row_id=task.id,
                    user_id=task.user_id,
                    task_id=task.id,
                    issue="missing",
                )
            )
            continue

        fields = tuple(
            field
            for field in _different_fields(task, shard_task, TaskResource)
            if field not in ignore_fields
        )
        if fields:
            mismatched += 1
            details.append(
                LegacyShardComparisonIssue(
                    row_type="task",
                    row_id=task.id,
                    user_id=task.user_id,
                    task_id=task.id,
                    issue="mismatched",
                    fields=fields,
                )
            )

    return LegacyTaskShardComparisonResult(
        legacy_tasks=len(tasks),
        missing_tasks=missing,
        mismatched_tasks=mismatched,
        details=tuple(details),
    )


def _copy_subtask_batch(
    db: Session,
    subtasks: list[Subtask],
    *,
    owner_cache: dict[int, int | None],
    dry_run: bool,
) -> LegacyTaskShardMigrationResult:
    copied = 0
    orphaned = 0
    for subtask in subtasks:
        owner_id = _task_owner_user_id(db, subtask.task_id, owner_cache)
        if owner_id is None:
            orphaned += 1
            continue

        model = subtask_model_for_owner(owner_id)
        if db.query(model.id).filter(model.id == subtask.id).first() is not None:
            continue
        copied += 1
        if not dry_run:
            db.add(model(**_model_values(subtask, Subtask)))

    return LegacyTaskShardMigrationResult(
        subtasks_seen=len(subtasks),
        subtasks_copied=copied,
        orphan_subtasks=orphaned,
    )


def _compare_subtask_batch(
    db: Session,
    subtasks: list[Subtask],
    *,
    owner_cache: dict[int, int | None],
) -> LegacyTaskShardComparisonResult:
    missing = 0
    mismatched = 0
    orphaned = 0
    details: list[LegacyShardComparisonIssue] = []
    for subtask in subtasks:
        owner_id = _task_owner_user_id(db, subtask.task_id, owner_cache)
        if owner_id is None:
            orphaned += 1
            details.append(
                LegacyShardComparisonIssue(
                    row_type="subtask",
                    row_id=subtask.id,
                    user_id=subtask.user_id,
                    task_id=subtask.task_id,
                    issue="orphan",
                )
            )
            continue

        model = subtask_model_for_owner(owner_id)
        shard_subtask = db.query(model).filter(model.id == subtask.id).first()
        if shard_subtask is None:
            missing += 1
            details.append(
                LegacyShardComparisonIssue(
                    row_type="subtask",
                    row_id=subtask.id,
                    user_id=subtask.user_id,
                    task_id=subtask.task_id,
                    issue="missing",
                )
            )
            continue

        fields = _different_fields(subtask, shard_subtask, Subtask)
        if fields:
            mismatched += 1
            details.append(
                LegacyShardComparisonIssue(
                    row_type="subtask",
                    row_id=subtask.id,
                    user_id=subtask.user_id,
                    task_id=subtask.task_id,
                    issue="mismatched",
                    fields=fields,
                )
            )

    return LegacyTaskShardComparisonResult(
        legacy_subtasks=len(subtasks),
        missing_subtasks=missing,
        mismatched_subtasks=mismatched,
        orphan_subtasks=orphaned,
        details=tuple(details),
    )


def _task_owner_user_id(
    db: Session,
    task_id: int,
    owner_cache: dict[int, int | None],
) -> int | None:
    if task_id not in owner_cache:
        row = db.query(TaskResource.user_id).filter(TaskResource.id == task_id).first()
        owner_cache[task_id] = int(row[0]) if row is not None else None
    return owner_cache[task_id]


def _model_values(row, source_model: type) -> dict:
    return {
        column.name: getattr(row, column.name)
        for column in source_model.__table__.columns
    }


def _different_fields(left, right, source_model: type) -> tuple[str, ...]:
    return tuple(
        column.name
        for column in source_model.__table__.columns
        if getattr(left, column.name) != getattr(right, column.name)
    )
