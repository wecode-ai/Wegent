from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from threading import Lock
from typing import TypeAlias

from sqlalchemy import MetaData
from sqlalchemy.orm import registry

from app.models.task import TaskResource
from shared.models.db.subtask import Subtask
from wecode.config.task_sharding_config import task_sharding_settings

from .task_id import (
    SLOT_COUNT,
    is_new_task_id,
    validate_slot,
)
from .uuid_factory.user_scoped_id_factory import UID_MASK, uid_from_id

SHARD_COUNT = task_sharding_settings.WECODE_TASK_SHARD_COUNT
LEGACY_SHARD_KEY = None

ShardKey: TypeAlias = int | None

_shard_metadata = MetaData()
_mapper_registry = registry(metadata=_shard_metadata)
_model_cache: dict[str, type] = {}
_model_cache_lock = Lock()


def physical_shard_for_slot(slot: int) -> int:
    return validate_slot(slot) % SHARD_COUNT


def shard_index(slot: int) -> int:
    return physical_shard_for_slot(slot)


def task_table_name(user_id: int) -> str:
    return _task_table_name_for_slot(_slot_from_user_id(user_id))


def subtask_table_name_by_task_id(task_id: int) -> str:
    if not is_new_task_id(task_id):
        return Subtask.__tablename__
    return _subtask_table_name_for_slot(_slot_from_new_id(task_id))


def task_model_for_user(user_id: int) -> type:
    return _model_for_table(TaskResource, task_table_name(user_id), "TaskResourceShard")


def subtask_model_for_owner(owner_user_id: int) -> type:
    return _subtask_model_for_slot(_slot_from_user_id(owner_user_id))


def task_model_for_task_id(task_id: int) -> type:
    if not is_new_task_id(task_id):
        return TaskResource
    return _task_model_for_slot(_slot_from_new_id(task_id))


def subtask_model_for_task_id(task_id: int) -> type:
    if not is_new_task_id(task_id):
        return Subtask
    return _subtask_model_for_slot(_slot_from_new_id(task_id))


def subtask_model_for_subtask_id(subtask_id: int) -> type:
    if not is_new_task_id(subtask_id):
        return Subtask
    return _subtask_model_for_slot(_slot_from_new_id(subtask_id))


def group_task_ids_by_shard(task_ids: Sequence[int]) -> dict[ShardKey, list[int]]:
    grouped: dict[ShardKey, list[int]] = defaultdict(list)
    for task_id in task_ids:
        if not is_new_task_id(task_id):
            grouped[LEGACY_SHARD_KEY].append(task_id)
            continue
        grouped[physical_shard_for_slot(_slot_from_new_id(task_id))].append(task_id)
    return dict(grouped)


def _slot_from_new_id(encoded_id: int) -> int:
    """Extract routing slot from a new-format (uid+reserved+seq) ID."""
    uid = uid_from_id(encoded_id)
    return uid % SLOT_COUNT


def _slot_from_user_id(user_id: int) -> int:
    if not isinstance(user_id, int) or isinstance(user_id, bool):
        raise ValueError("user_id must be an integer")
    if user_id < 0 or user_id > UID_MASK:
        raise ValueError(f"user_id must be 0–{UID_MASK}, got {user_id}")
    return user_id % SLOT_COUNT


def _task_model_for_slot(slot: int) -> type:
    return _model_for_table(
        TaskResource, _task_table_name_for_slot(slot), "TaskResourceShard"
    )


def _subtask_model_for_slot(slot: int) -> type:
    return _model_for_table(Subtask, _subtask_table_name_for_slot(slot), "SubtaskShard")


def _task_table_name_for_slot(slot: int) -> str:
    return f"tasks_{physical_shard_for_slot(slot):04d}"


def _subtask_table_name_for_slot(slot: int) -> str:
    return f"subtasks_{physical_shard_for_slot(slot):04d}"


def _model_for_table(source_model: type, table_name: str, class_prefix: str) -> type:
    cached_model = _model_cache.get(table_name)
    if cached_model is not None:
        return cached_model

    with _model_cache_lock:
        cached_model = _model_cache.get(table_name)
        if cached_model is not None:
            return cached_model

        table = source_model.__table__.to_metadata(_shard_metadata, name=table_name)
        model = type(
            _class_name(class_prefix, table_name),
            (object,),
            {
                "__module__": __name__,
                "__source_model__": source_model,
                "__table__": table,
                **_copy_public_constants(source_model),
                **_copy_public_classmethods(source_model),
            },
        )
        _mapper_registry.map_imperatively(model, table)
        _model_cache[table_name] = model
        return model


def _class_name(class_prefix: str, table_name: str) -> str:
    suffix = table_name.rsplit("_", maxsplit=1)[-1]
    return f"{class_prefix}{suffix}"


def _copy_public_constants(source_model: type) -> dict[str, object]:
    return {
        name: value
        for name, value in source_model.__dict__.items()
        if name.isupper() and not name.startswith("_")
    }


def _copy_public_classmethods(source_model: type) -> dict[str, object]:
    return {
        name: value
        for name, value in source_model.__dict__.items()
        if isinstance(value, classmethod) and not name.startswith("_")
    }
