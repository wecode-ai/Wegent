from __future__ import annotations

from wecode.config.task_sharding_config import task_sharding_settings

SHARD_COUNT = task_sharding_settings.WECODE_TASK_SHARD_COUNT


def shard_for_user_id(user_id: int) -> int:
    if isinstance(user_id, bool) or not isinstance(user_id, int):
        raise ValueError("user_id must be an integer")
    if user_id < 0:
        raise ValueError("user_id must be non-negative")
    return user_id % SHARD_COUNT


def task_table_name_for_owner(owner_user_id: int) -> str:
    return f"tasks_{shard_for_user_id(owner_user_id):04d}"


def subtask_table_name_for_owner(owner_user_id: int) -> str:
    return f"subtasks_{shard_for_user_id(owner_user_id):04d}"
