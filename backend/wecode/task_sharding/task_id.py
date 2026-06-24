from __future__ import annotations

from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    RESERVED_SHIFT,
    SEQ_MASK,
    UID_SHIFT,
)

SLOT_COUNT = 1 << 10  # 1024 slots (kept for shard routing compatibility)

MAX_JS_SAFE_INTEGER = (1 << 53) - 1

_MIN_USER_SCOPED_ID = 1 << UID_SHIFT


def validate_user_id(user_id: int) -> int:
    if isinstance(user_id, bool) or not isinstance(user_id, int):
        raise ValueError("user_id must be an integer")
    if user_id < 0:
        raise ValueError("user_id must be non-negative")
    return user_id


def validate_slot(slot: int) -> int:
    slot_mask = SLOT_COUNT - 1
    if isinstance(slot, bool) or not isinstance(slot, int):
        raise ValueError("slot must be an integer")
    if slot < 0 or slot > slot_mask:
        raise ValueError(f"slot must be between 0 and {slot_mask}")
    return slot


def is_new_task_id(task_id: int) -> bool:
    if not isinstance(task_id, int) or isinstance(task_id, bool):
        return False
    if task_id < _MIN_USER_SCOPED_ID or task_id > MAX_JS_SAFE_INTEGER:
        return False

    uid = task_id >> UID_SHIFT
    reserved = (task_id >> RESERVED_SHIFT) & 0xF
    sequence = task_id & SEQ_MASK
    return uid > 0 and reserved == 0 and sequence > 0
