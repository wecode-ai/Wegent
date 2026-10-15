# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Data-conversion coverage for the collaboration storage migration."""

import importlib.util
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from pytest import MonkeyPatch
from sqlalchemy.engine import Connection, Engine

from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext


def _load_migration() -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20260911_b8e2c4f6a901_add_collaboration_workspaces.py"
    )
    spec = importlib.util.spec_from_file_location(
        "collaboration_workspace_migration", path
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _legacy_engine() -> Engine:
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    sa.Table(
        "loop_items",
        metadata,
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("resource_type", sa.String(24), nullable=False),
        sa.Column("cloud_project_id", sa.String(64)),
        sa.Column("loop_item_id", sa.String(64)),
        sa.Column("description", sa.Text, nullable=False, default=""),
        sa.Column("created_by_user_id", sa.Integer),
        sa.Column("updated_by_user_id", sa.Integer),
        sa.Column("assignee_user_id", sa.Integer),
        sa.Column("assignee_agent_id", sa.String(64), nullable=False, default=""),
        sa.Column("assignee_team_id", sa.Integer),
        sa.Column("device_id", sa.String(100)),
        sa.Column("metadata", sa.JSON),
        sa.Column("status", sa.String(32)),
    )
    sa.Table(
        "resource_members",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("resource_type", sa.String(50), nullable=False),
        sa.Column("resource_id", sa.Integer, nullable=False),
        sa.Column("entity_type", sa.String(20), nullable=False),
        sa.Column("entity_id", sa.String(100), nullable=False),
        sa.Column("user_id", sa.Integer, nullable=False, default=0),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("invited_by_user_id", sa.Integer, nullable=False, default=0),
    )
    sa.Table(
        "kinds",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer, nullable=False),
        sa.Column("kind", sa.String(50), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("namespace", sa.String(100), nullable=False, default="default"),
        sa.Column("json", sa.JSON, nullable=False),
        sa.Column("is_active", sa.Boolean, nullable=False),
    )
    metadata.create_all(engine)
    return engine


def _insert_legacy_data(connection: Connection) -> None:
    loop_items = sa.Table("loop_items", sa.MetaData(), autoload_with=connection)
    connection.execute(
        loop_items.insert(),
        [
            _node("1001", "project", 10),
            _node("1002", "project", 10),
            _node("2001", "project", 20),
            _node(
                "agent-1001",
                "chat_agent",
                10,
                project_id="1001",
                device_id="mac-10",
                metadata={"wegent_team_id": 900},
            ),
            _node(
                "issue-human",
                "task",
                10,
                project_id="1001",
                assignee_user_id=31,
            ),
            _node(
                "issue-agent",
                "task",
                10,
                project_id="1001",
                assignee_agent_id="agent-1001",
            ),
        ],
    )
    members = sa.Table("resource_members", sa.MetaData(), autoload_with=connection)
    connection.execute(
        members.insert(),
        [
            _member("CloudProject", 1001, "user", "31", 31, "Maintainer"),
            _member("CloudProject", 2001, "user", "41", 41, "Reporter"),
        ],
    )
    kinds = sa.Table("kinds", sa.MetaData(), autoload_with=connection)
    connection.execute(
        kinds.insert(),
        [
            {
                "id": 900,
                "user_id": 10,
                "kind": "Team",
                "name": "Product team",
                "namespace": "default",
                "json": {},
                "is_active": True,
            },
            {
                "id": 901,
                "user_id": 10,
                "kind": "Device",
                "name": "mac-10",
                "namespace": "default",
                "json": {},
                "is_active": True,
            },
        ],
    )


def _node(
    node_id: str,
    resource_type: str,
    user_id: int,
    *,
    project_id: str | None = None,
    device_id: str | None = None,
    metadata: dict[str, object] | None = None,
    assignee_user_id: int | None = None,
    assignee_agent_id: str = "",
) -> dict[str, object]:
    return {
        "id": node_id,
        "resource_type": resource_type,
        "cloud_project_id": project_id,
        "loop_item_id": None,
        "description": "",
        "created_by_user_id": user_id,
        "updated_by_user_id": user_id,
        "assignee_user_id": assignee_user_id,
        "assignee_agent_id": assignee_agent_id,
        "assignee_team_id": None,
        "device_id": device_id,
        "metadata": metadata,
        "status": "active",
    }


def _member(
    resource_type: str,
    resource_id: int,
    entity_type: str,
    entity_id: str,
    user_id: int,
    role: str,
) -> dict[str, object]:
    return {
        "resource_type": resource_type,
        "resource_id": resource_id,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "user_id": user_id,
        "role": role,
        "status": "approved",
        "invited_by_user_id": 0,
    }


def _bind(
    migration: ModuleType, monkeypatch: MonkeyPatch, connection: Connection
) -> None:
    monkeypatch.setattr(
        migration,
        "op",
        Operations(MigrationContext.configure(connection)),
    )


def test_upgrade_reuses_existing_tables_and_downgrade_removes_generated_rows(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    engine = _legacy_engine()
    with engine.begin() as connection:
        _insert_legacy_data(connection)
        inspector = sa.inspect(connection)
        tables_before = set(inspector.get_table_names())
        loop_columns_before = {
            column["name"] for column in inspector.get_columns("loop_items")
        }
        _bind(migration, monkeypatch, connection)

        migration.upgrade()

        assert set(sa.inspect(connection).get_table_names()) == tables_before
        assert {
            column["name"]
            for column in sa.inspect(connection).get_columns("loop_items")
        } == loop_columns_before
        _assert_workspace_kinds(connection)
        _assert_resource_grants(connection)
        _assert_assignment_events(connection)

        migration.downgrade()

        kinds = sa.Table("kinds", sa.MetaData(), autoload_with=connection)
        assert (
            connection.execute(
                sa.select(sa.func.count())
                .select_from(kinds)
                .where(kinds.c.kind == "CollaborationWorkspace")
            ).scalar_one()
            == 0
        )
        loop_items = sa.Table("loop_items", sa.MetaData(), autoload_with=connection)
        assert (
            connection.execute(
                sa.select(sa.func.count())
                .select_from(loop_items)
                .where(loop_items.c.resource_type == "comment")
            ).scalar_one()
            == 0
        )
    engine.dispose()


def _workspace_ids(connection: Connection) -> dict[int, int]:
    kinds = sa.Table("kinds", sa.MetaData(), autoload_with=connection)
    return {
        int(row.user_id): int(row.id)
        for row in connection.execute(
            sa.select(kinds.c.id, kinds.c.user_id).where(
                kinds.c.kind == "CollaborationWorkspace"
            )
        )
    }


def _assert_workspace_kinds(connection: Connection) -> None:
    assert set(_workspace_ids(connection)) == {10, 20}


def _assert_resource_grants(connection: Connection) -> None:
    workspace_ids = _workspace_ids(connection)
    members = sa.Table("resource_members", sa.MetaData(), autoload_with=connection)
    rows = connection.execute(
        sa.select(
            members.c.resource_type,
            members.c.resource_id,
            members.c.entity_type,
            members.c.entity_id,
            members.c.role,
        ).order_by(members.c.id)
    ).all()
    assert ("Workspace", workspace_ids[10], "user", "10", "Owner") in rows
    assert ("Workspace", workspace_ids[10], "user", "31", "Maintainer") in rows
    assert ("CloudProject", 1001, "workspace", str(workspace_ids[10]), "Owner") in rows
    assert ("CloudProject", 1002, "workspace", str(workspace_ids[10]), "Owner") in rows
    assert ("Team", 900, "workspace", str(workspace_ids[10]), "Developer") in rows
    assert ("Device", 901, "workspace", str(workspace_ids[10]), "Developer") in rows


def _assert_assignment_events(connection: Connection) -> None:
    loop_items = sa.Table("loop_items", sa.MetaData(), autoload_with=connection)
    rows = connection.execute(
        sa.select(
            loop_items.c.loop_item_id,
            loop_items.c.metadata,
        )
        .where(loop_items.c.resource_type == "comment")
        .order_by(loop_items.c.loop_item_id)
    ).all()
    assert len(rows) == 2
    assert rows[0][0] == "issue-agent"
    assert rows[0][1]["target_type"] == "agent"
    assert rows[0][1]["target_id"] == "agent-1001"
    assert rows[1][0] == "issue-human"
    assert rows[1][1]["target_type"] == "human"
    assert rows[1][1]["target_id"] == "31"
