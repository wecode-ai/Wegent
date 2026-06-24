import importlib

import pytest

from app.models.task import TaskResource
from shared.models.db.subtask import Subtask
from wecode.config.task_sharding_config import task_sharding_settings
from wecode.task_sharding.shard import (
    LEGACY_SHARD_KEY,
    SHARD_COUNT,
    group_task_ids_by_shard,
    physical_shard_for_slot,
    subtask_model_for_subtask_id,
    subtask_model_for_task_id,
    subtask_table_name_by_task_id,
    task_model_for_task_id,
    task_model_for_user,
    task_table_name,
)
from wecode.task_sharding.task_id import SLOT_COUNT
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    encode_user_scoped_id,
)


def test_physical_shard_for_slot_uses_slot_modulo_shard_count():
    assert physical_shard_for_slot(0) == 0
    assert physical_shard_for_slot(SHARD_COUNT - 1) == SHARD_COUNT - 1
    assert physical_shard_for_slot(SHARD_COUNT) == 0
    assert physical_shard_for_slot(SHARD_COUNT + 1) == 1


@pytest.mark.parametrize("slot", [-1, SLOT_COUNT, "1", 1.2, True])
def test_physical_shard_for_slot_rejects_invalid_slot(slot):
    with pytest.raises(ValueError):
        physical_shard_for_slot(slot)


def test_task_table_name_uses_four_digit_physical_shard_suffix():
    assert task_table_name(SHARD_COUNT + 1) == "tasks_0001"


def test_new_task_id_routes_to_sharded_task_model():
    generated_id = encode_user_scoped_id(1041, 1)

    model = task_model_for_task_id(generated_id)

    assert model.__table__.name == f"tasks_{1041 % SHARD_COUNT:04d}"
    assert model is task_model_for_user(1041)


def test_new_subtask_routes_by_task_id_to_sharded_subtask_model():
    generated_task_id = encode_user_scoped_id(31, 1)

    model = subtask_model_for_task_id(generated_task_id)

    expected_table = f"subtasks_{31 % SHARD_COUNT:04d}"
    assert subtask_table_name_by_task_id(generated_task_id) == expected_table
    assert model.__table__.name == expected_table


def test_new_subtask_routes_by_subtask_id_to_sharded_subtask_model():
    generated_subtask_id = encode_user_scoped_id(18, 1)

    model = subtask_model_for_subtask_id(generated_subtask_id)

    assert model.__table__.name == f"subtasks_{18 % SHARD_COUNT:04d}"


def test_old_ids_fallback_to_legacy_models():
    assert task_model_for_task_id(123) is TaskResource
    assert subtask_model_for_task_id(123) is Subtask
    assert subtask_model_for_subtask_id(123) is Subtask


def test_group_task_ids_by_shard_groups_new_ids_and_legacy_ids():
    task_id_1 = encode_user_scoped_id(1, 1)
    task_id_17 = encode_user_scoped_id(17, 2)
    task_id_2 = encode_user_scoped_id(2, 3)

    grouped = group_task_ids_by_shard([123, task_id_1, task_id_17, task_id_2])

    expected: dict[int | None, list[int]] = {LEGACY_SHARD_KEY: [123]}
    expected.setdefault(physical_shard_for_slot(1), []).append(task_id_1)
    expected.setdefault(physical_shard_for_slot(17), []).append(task_id_17)
    expected.setdefault(physical_shard_for_slot(2), []).append(task_id_2)

    assert grouped == expected


def test_dynamic_models_are_cached_by_table_name():
    assert task_model_for_user(17) is task_model_for_user(33)


def test_shard_models_include_all_legacy_columns():
    task_columns = set(TaskResource.__table__.columns.keys())
    subtask_columns = set(Subtask.__table__.columns.keys())

    assert task_columns <= set(task_model_for_user(17).__table__.columns.keys())
    assert subtask_columns <= set(
        subtask_model_for_task_id(encode_user_scoped_id(17, 1)).__table__.columns.keys()
    )


def test_shard_count_can_be_configured_for_local_development(monkeypatch):
    import wecode.task_sharding.shard as shard_module

    original_count = task_sharding_settings.WECODE_TASK_SHARD_COUNT
    monkeypatch.setattr(
        task_sharding_settings,
        "WECODE_TASK_SHARD_COUNT",
        2,
        raising=False,
    )
    reloaded = importlib.reload(shard_module)

    try:
        assert reloaded.SHARD_COUNT == 2
        assert reloaded.physical_shard_for_slot(2) == 0
        assert reloaded.physical_shard_for_slot(3) == 1
        assert reloaded.task_table_name(3) == "tasks_0001"
    finally:
        monkeypatch.setattr(
            task_sharding_settings,
            "WECODE_TASK_SHARD_COUNT",
            original_count,
            raising=False,
        )
        importlib.reload(shard_module)


def test_same_slot_routes_predictably_for_different_shard_counts(monkeypatch):
    import wecode.task_sharding.shard as shard_module

    original_count = task_sharding_settings.WECODE_TASK_SHARD_COUNT
    try:
        monkeypatch.setattr(
            task_sharding_settings,
            "WECODE_TASK_SHARD_COUNT",
            2,
            raising=False,
        )
        reloaded = importlib.reload(shard_module)
        assert reloaded.physical_shard_for_slot(17) == 1
        assert reloaded.task_table_name(17) == "tasks_0001"

        monkeypatch.setattr(
            task_sharding_settings,
            "WECODE_TASK_SHARD_COUNT",
            16,
            raising=False,
        )
        reloaded = importlib.reload(shard_module)
        assert reloaded.physical_shard_for_slot(17) == 1
        assert reloaded.task_table_name(17) == "tasks_0001"
    finally:
        monkeypatch.setattr(
            task_sharding_settings,
            "WECODE_TASK_SHARD_COUNT",
            original_count,
            raising=False,
        )
        importlib.reload(shard_module)
