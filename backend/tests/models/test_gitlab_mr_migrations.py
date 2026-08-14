# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Static smoke checks for the squashed GitLab MR migration chain."""

import importlib.util
from pathlib import Path
from types import ModuleType


def _load_migration(filename: str) -> ModuleType:
    path = Path(__file__).parents[2] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(filename, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_mr_tables_migration_single_revision_with_all_columns() -> None:
    migration = _load_migration("20260812_5e175aa087f2_add_gitlab_mr_tables.py")
    assert migration.revision == "5e175aa087f2"
    assert migration.down_revision == "735edcb17bec"
    source = Path(migration.__file__).read_text(encoding="utf-8")
    # Folding the later add-column migrations into the table creation removes the
    # ALTER-on-populated-table risk; both columns must be present here.
    assert '"auto_retrigger_count"' in source
    assert '"seen_note_ids"' in source


def test_add_column_migrations_folded_away() -> None:
    versions = Path(__file__).parents[2] / "alembic" / "versions"
    filenames = {p.name for p in versions.glob("*.py")}
    assert "20260813_03da45d84850_add_mr_auto_retrigger_count.py" not in filenames
    assert "20260813_4c8d2a6f0b3e_add_mr_seen_note_ids.py" not in filenames


def test_fk_drop_and_merge_revisions_updated() -> None:
    fk_drop = _load_migration(
        "20260813_b7c9e1f3a5d2_drop_loop_items_local_project_fk.py"
    )
    assert fk_drop.revision == "b7c9e1f3a5d2"
    assert fk_drop.down_revision == "735edcb17bec"
    merge = _load_migration("20260813_0a3f5b7c9d1e_merge_migration_heads.py")
    assert merge.revision == "0a3f5b7c9d1e"
    assert merge.down_revision == (
        "5e175aa087f2",
        "b7c9e1f3a5d2",
        "f5e4d3c2b1a0",
    )
