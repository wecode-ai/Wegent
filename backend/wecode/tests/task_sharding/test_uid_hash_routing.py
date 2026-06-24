import pytest

from wecode.task_sharding.uid_hash import (
    shard_for_user_id,
    subtask_table_name_for_owner,
    task_table_name_for_owner,
)

pytestmark = pytest.mark.unit


def test_uid_hash_uses_configured_shard_count(monkeypatch):
    import wecode.task_sharding.uid_hash as uid_hash_module

    monkeypatch.setattr(uid_hash_module, "SHARD_COUNT", 16)

    assert shard_for_user_id(0) == 0
    assert shard_for_user_id(17) == 1
    assert shard_for_user_id(1025) == 1


@pytest.mark.parametrize("user_id", [-1, True, "1", 1.2, None])
def test_uid_hash_rejects_invalid_user_id(user_id):
    with pytest.raises(ValueError):
        shard_for_user_id(user_id)


def test_uid_hash_builds_four_digit_table_names(monkeypatch):
    import wecode.task_sharding.uid_hash as uid_hash_module

    monkeypatch.setattr(uid_hash_module, "SHARD_COUNT", 16)

    assert task_table_name_for_owner(17) == "tasks_0001"
    assert subtask_table_name_for_owner(31) == "subtasks_0015"
