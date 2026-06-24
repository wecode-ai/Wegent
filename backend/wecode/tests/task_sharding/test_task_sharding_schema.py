# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schema checks for task/subtask sharding prerequisites."""

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa

from app.models.resource_member import ResourceMember
from app.models.share_link import ShareLink
from app.models.subscription import BackgroundExecution
from app.models.task import TaskResource
from app.models.wiki import WikiGeneration
from shared.models.db.subtask import Subtask
from shared.models.db.subtask_context import SubtaskContext
from shared.models.db.work_queue import QueueMessage

pytestmark = pytest.mark.unit

BACKEND_ROOT = Path(__file__).resolve().parents[3]

BIGINT_COLUMNS = [
    (TaskResource, "id"),
    (Subtask, "id"),
    (Subtask, "task_id"),
    (Subtask, "parent_id"),
    (Subtask, "reply_to_subtask_id"),
    (SubtaskContext, "subtask_id"),
    (ResourceMember, "resource_id"),
    (ResourceMember, "copied_resource_id"),
    (ShareLink, "resource_id"),
    (BackgroundExecution, "task_id"),
    (WikiGeneration, "task_id"),
    (QueueMessage, "source_task_id"),
    (QueueMessage, "process_task_id"),
]


def load_migration(module_name: str, filename: str):
    migration_path = BACKEND_ROOT / "alembic" / "versions" / filename
    assert migration_path.exists()

    spec = importlib.util.spec_from_file_location(module_name, migration_path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def migration_path(filename: str) -> Path:
    return BACKEND_ROOT / "alembic" / "versions" / filename


@pytest.mark.parametrize(("model", "column_name"), BIGINT_COLUMNS)
def test_task_related_id_columns_are_bigint(model, column_name: str) -> None:
    column = model.__table__.c[column_name]

    assert isinstance(column.type, sa.BigInteger)


@pytest.mark.parametrize("model", [TaskResource, Subtask])
def test_single_table_primary_ids_keep_autoincrement(model) -> None:
    column = model.__table__.c.id

    assert column.autoincrement is True


def test_task_shard_migration_declares_expected_tables(monkeypatch) -> None:
    from wecode.config.task_sharding_config import task_sharding_settings

    monkeypatch.setattr(task_sharding_settings, "WECODE_TASK_SHARD_COUNT", 16)
    migration = load_migration(
        "task_shard_migration",
        "20260612_d5e6f7a8b9c0_add_task_subtask_bigint_shards.py",
    )

    assert migration.down_revision == "c4d5e6f7a8b9"
    assert migration.TASK_SHARD_TABLES == tuple(
        f"tasks_{index:04d}" for index in range(16)
    )
    assert migration.SUBTASK_SHARD_TABLES == tuple(
        f"subtasks_{index:04d}" for index in range(16)
    )
    assert migration.TASK_ID_COLUMNS[0] == (
        "tasks",
        "id",
        False,
        "Primary key",
        None,
        True,
    )
    assert migration.SUBTASK_ID_COLUMNS[0] == (
        "subtasks",
        "id",
        False,
        None,
        None,
        True,
    )


def test_task_shard_migration_does_not_create_uid_index_tables() -> None:
    migration = load_migration(
        "task_shard_migration_without_uid_indexes",
        "20260612_d5e6f7a8b9c0_add_task_subtask_bigint_shards.py",
    )

    assert not hasattr(migration, "TASK_INDEX_TABLE")
    assert not hasattr(migration, "SUBTASK_INDEX_TABLE")
    assert not hasattr(migration, "_create_route_tables")
    assert not migration_path(
        "20260616_e6f7a8b9c0d1_drop_task_subtask_uid_index.py"
    ).exists()


def test_task_shard_migration_uses_configured_shard_count(monkeypatch) -> None:
    from wecode.config.task_sharding_config import task_sharding_settings

    monkeypatch.setattr(task_sharding_settings, "WECODE_TASK_SHARD_COUNT", 2)
    migration = load_migration(
        "task_shard_migration_configured",
        "20260612_d5e6f7a8b9c0_add_task_subtask_bigint_shards.py",
    )

    assert migration.SHARD_COUNT == 2
    assert migration.TASK_SHARD_TABLES == ("tasks_0000", "tasks_0001")
    assert migration.SUBTASK_SHARD_TABLES == ("subtasks_0000", "subtasks_0001")
