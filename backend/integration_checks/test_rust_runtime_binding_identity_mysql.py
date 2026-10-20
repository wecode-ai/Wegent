"""Execute the Rust cloud-context binding query against isolated MySQL data."""

from datetime import datetime
from pathlib import Path

import pytest
import sqlalchemy as sa

from integration_checks.test_collaboration_permission_mysql import (  # noqa: F401
    mysql_url,
)

SQL = (
    Path(__file__).parents[2] / "backend-rs/src/loop_tasks/cloud_context_binding.sql"
).read_text()


@pytest.fixture
def binding_database(mysql_url):
    engine = sa.create_engine(mysql_url)
    metadata = sa.MetaData()
    bindings = sa.Table(
        "loop_items",
        metadata,
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("resource_type", sa.String(32)),
        sa.Column("task_user_id", sa.Integer),
        sa.Column("device_id", sa.String(255)),
        sa.Column("task_id", sa.String(255)),
        sa.Column("linked_at", sa.DateTime),
        sa.Column("unlinked_at", sa.DateTime),
        sa.Column("deleted_at", sa.DateTime),
    )
    metadata.create_all(engine)
    try:
        yield engine, bindings
    finally:
        engine.dispose()


def _context(engine, owner_id, aliases, task_id="runtime-task"):
    query = SQL.format(
        columns="loop_items.id, loop_items.device_id",
        device_ids=", ".join("?" for _ in aliases),
    ).replace("?", "%s")
    with engine.connect() as db:
        return (
            db.exec_driver_sql(query, (owner_id, *aliases, task_id))
            .mappings()
            .one_or_none()
        )


@pytest.mark.parametrize("stored_alias", ["electron-app", "app-record-7"])
@pytest.mark.parametrize("unset", [None, datetime(1970, 1, 1, 0, 0, 1)])
def test_rust_cloud_context_alias_sql_keeps_the_binding_address_and_owner(
    binding_database, stored_alias, unset
):
    engine, bindings = binding_database
    baseline = {
        "resource_type": "execution",
        "task_user_id": 19,
        "device_id": stored_alias,
        "task_id": "runtime-task",
        "linked_at": datetime(2026, 10, 15),
        "unlinked_at": unset,
        "deleted_at": unset,
    }
    invalid_rows = [
        {"id": "foreign-owner", "task_user_id": 20},
        {"id": "other-session", "task_id": "another-task"},
        {"id": "other-installation", "device_id": "app-record-8"},
        {"id": "unlinked", "unlinked_at": datetime(2026, 10, 16)},
        {"id": "deleted", "deleted_at": datetime(2026, 10, 16)},
        {"id": "different-resource", "resource_type": "task"},
    ]
    with engine.begin() as db:
        db.execute(bindings.insert(), [{**baseline, "id": "owned-binding"}])
        db.execute(
            bindings.insert(),
            [
                {
                    **baseline,
                    "linked_at": datetime(2026, 10, 16),
                    **changes,
                }
                for changes in invalid_rows
            ],
        )

    for aliases in [
        ["electron-app", "app-record-7"],
        ["app-record-7", "electron-app"],
    ]:
        context = _context(engine, 19, aliases)
        assert dict(context) == {"id": "owned-binding", "device_id": stored_alias}
    assert _context(engine, 21, ["electron-app", "app-record-7"]) is None

    with engine.begin() as db:
        db.execute(bindings.delete().where(bindings.c.id == "owned-binding"))
    assert _context(engine, 19, ["electron-app", "app-record-7"]) is None


def test_rust_cloud_context_alias_sql_selects_the_newest_active_binding(
    binding_database,
):
    engine, bindings = binding_database
    with engine.begin() as db:
        db.execute(
            bindings.insert(),
            [
                {
                    "id": row_id,
                    "resource_type": "execution",
                    "task_user_id": 19,
                    "device_id": alias,
                    "task_id": "runtime-task",
                    "linked_at": linked_at,
                }
                for row_id, alias, linked_at in [
                    ("1", "electron-app", datetime(2026, 10, 15)),
                    ("2", "app-record-7", datetime(2026, 10, 16)),
                    ("3", "electron-app", datetime(2026, 10, 16)),
                ]
            ],
        )

    assert dict(_context(engine, 19, ["electron-app", "app-record-7"])) == {
        "id": "3",
        "device_id": "electron-app",
    }
