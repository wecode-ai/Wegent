# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contract tests for the MySQL loop-item sentinel schema."""

import importlib.util
from pathlib import Path

import pytest

from app.db.mysql_loop_items_schema import (
    MYSQL_LOOP_ITEM_FOREIGN_KEYS,
    MYSQL_LOOP_ITEM_SENTINEL_COLUMNS,
    MYSQL_LOOP_ITEM_UNIQUE_PROJECTIONS,
)

pytestmark = pytest.mark.unit


def test_mysql_sentinel_schema_covers_optional_constrained_columns() -> None:
    expected_foreign_keys = {
        "cloud_project_id",
        "parent_id",
        "loop_item_id",
        "delivery_id",
        "local_project_id",
        "backend_task_id",
    }
    expected_unique_sources = {"public_id", "project_key", "storage_prefix"}

    assert set(MYSQL_LOOP_ITEM_FOREIGN_KEYS) == expected_foreign_keys
    assert expected_foreign_keys.issubset(MYSQL_LOOP_ITEM_SENTINEL_COLUMNS)
    assert {
        source for source, _type in MYSQL_LOOP_ITEM_UNIQUE_PROJECTIONS.values()
    } == expected_unique_sources
    assert expected_unique_sources.issubset(MYSQL_LOOP_ITEM_SENTINEL_COLUMNS)


def test_mysql_sentinel_schema_migration_is_current_head() -> None:
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "alembic"
        / "versions"
        / "20260804_c0d1e2f3a4b5_align_mysql_loop_items_schema.py"
    )
    spec = importlib.util.spec_from_file_location(
        "mysql_loop_items_schema_migration", migration_path
    )
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    assert migration.revision == "c0d1e2f3a4b5"
    assert migration.down_revision == "b9c0d1e2f3a4"
