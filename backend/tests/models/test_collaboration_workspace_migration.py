# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backfill coverage for the collaboration workspace migration."""

import importlib.util
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from pytest import MonkeyPatch
from sqlalchemy.dialects import mysql
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.schema import CreateTable

from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from app.models.issue_assignment import IssueAssignment
from app.models.workspace import Workspace


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
        sa.Column("created_by_user_id", sa.Integer),
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
        sa.Column("user_id", sa.Integer),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
    )
    sa.Table(
        "loop_item_executions",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("cloud_project_id", sa.String(64), nullable=False),
        sa.Column("loop_item_id", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
    )
    sa.Table(
        "kinds",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("kind", sa.String(255), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("user_id", sa.Integer),
        sa.Column("is_active", sa.Boolean, nullable=False),
    )
    metadata.create_all(engine)
    return engine


def _insert_legacy_data(connection: Connection) -> None:
    loop_items = sa.Table("loop_items", sa.MetaData(), autoload_with=connection)
    connection.execute(
        loop_items.insert(),
        [
            _loop_node("1001", "project", 10),
            _loop_node("1002", "project", 10),
            _loop_node("2001", "project", 20),
            _loop_node(
                "agent-1001",
                "chat_agent",
                10,
                cloud_project_id="1001",
                metadata={"wegent_team_id": 900},
            ),
            _loop_node(
                "agent-1002",
                "chat_agent",
                10,
                cloud_project_id="1002",
                metadata={"wegent_team_id": 900},
            ),
            _loop_node(
                "agent-2001",
                "chat_agent",
                20,
                cloud_project_id="2001",
                metadata={"wegent_team_id": 901},
            ),
            _loop_node(
                "issue-human",
                "task",
                10,
                cloud_project_id="1001",
                assignee_user_id=31,
            ),
            _loop_node(
                "issue-project-agent",
                "task",
                10,
                cloud_project_id="1001",
                assignee_agent_id="agent-1001",
            ),
            _loop_node(
                "issue-team",
                "task",
                10,
                cloud_project_id="1002",
                assignee_team_id=900,
            ),
            _loop_node(
                "issue-unassigned",
                "task",
                20,
                cloud_project_id="2001",
            ),
        ],
    )
    members = sa.Table("resource_members", sa.MetaData(), autoload_with=connection)
    connection.execute(
        members.insert(),
        [
            _project_member(1001, 31, "Maintainer"),
            _project_member(1002, 31, "Maintainer"),
            _project_member(2001, 41, "RestrictedAnalyst"),
        ],
    )
    executions = sa.Table(
        "loop_item_executions", sa.MetaData(), autoload_with=connection
    )
    connection.execute(
        executions.insert(),
        [
            {
                "id": 501,
                "cloud_project_id": "1001",
                "loop_item_id": "issue-human",
                "status": "succeeded",
            },
            {
                "id": 502,
                "cloud_project_id": "2001",
                "loop_item_id": "issue-unassigned",
                "status": "pending",
            },
        ],
    )
    kinds = sa.Table("kinds", sa.MetaData(), autoload_with=connection)
    connection.execute(
        kinds.insert(),
        [
            {
                "id": 900,
                "kind": "Team",
                "name": "Shared product team",
                "user_id": 10,
                "is_active": True,
            },
            {
                "id": 901,
                "kind": "Team",
                "name": "Second user's team",
                "user_id": 20,
                "is_active": True,
            },
        ],
    )


def _loop_node(
    node_id: str,
    resource_type: str,
    created_by_user_id: int,
    *,
    cloud_project_id: str | None = None,
    assignee_user_id: int | None = None,
    assignee_agent_id: str = "",
    assignee_team_id: int | None = None,
    metadata: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "id": node_id,
        "resource_type": resource_type,
        "cloud_project_id": cloud_project_id,
        "created_by_user_id": created_by_user_id,
        "assignee_user_id": assignee_user_id,
        "assignee_agent_id": assignee_agent_id,
        "assignee_team_id": assignee_team_id,
        "device_id": None,
        "metadata": metadata,
        "status": "active",
    }


def _project_member(project_id: int, user_id: int, role: str) -> dict[str, object]:
    return {
        "resource_type": "CloudProject",
        "resource_id": project_id,
        "entity_type": "user",
        "entity_id": str(user_id),
        "user_id": user_id,
        "role": role,
        "status": "approved",
    }


def _bind_migration(
    migration: ModuleType, monkeypatch: MonkeyPatch, connection: Connection
) -> None:
    monkeypatch.setattr(
        migration,
        "op",
        Operations(MigrationContext.configure(connection)),
    )


def _legacy_rows(connection: Connection, table_name: str) -> list[dict[str, object]]:
    table = sa.Table(table_name, sa.MetaData(), autoload_with=connection)
    return [
        dict(row)
        for row in connection.execute(
            table.select().order_by(*table.primary_key.columns)
        ).mappings()
    ]


def test_backfill_real_legacy_collaboration_data_and_preserve_it_on_downgrade(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    engine = _legacy_engine()
    with engine.begin() as connection:
        _insert_legacy_data(connection)
        legacy_loop_items = _legacy_rows(connection, "loop_items")
        legacy_members = _legacy_rows(connection, "resource_members")
        legacy_executions = _legacy_rows(connection, "loop_item_executions")
        legacy_kinds = _legacy_rows(connection, "kinds")
        _bind_migration(migration, monkeypatch, connection)

        migration.upgrade()

        _assert_workspace_backfill(connection)
        _assert_member_backfill(connection)
        _assert_assignment_backfill(connection)
        _assert_shared_team_backfill(connection)

        migration.downgrade()

        assert _legacy_rows(connection, "loop_items") == legacy_loop_items
        assert _legacy_rows(connection, "resource_members") == legacy_members
        assert _legacy_rows(connection, "loop_item_executions") == legacy_executions
        assert _legacy_rows(connection, "kinds") == legacy_kinds
    engine.dispose()


def test_new_collaboration_tables_generate_mysql_compatible_ddl() -> None:
    workspace_ddl = str(
        CreateTable(Workspace.__table__).compile(dialect=mysql.dialect())
    )
    assignment_ddl = str(
        CreateTable(IssueAssignment.__table__).compile(dialect=mysql.dialect())
    )

    assert "description TEXT NOT NULL DEFAULT" not in workspace_ddl
    assert "COLLATE" not in assignment_ddl


def _assert_workspace_backfill(connection: Connection) -> None:
    workspaces = sa.Table(
        "collaboration_workspaces", sa.MetaData(), autoload_with=connection
    )
    workspace_rows = connection.execute(
        sa.select(
            workspaces.c.id,
            workspaces.c.created_by_user_id,
            workspaces.c.is_default,
        ).order_by(workspaces.c.created_by_user_id)
    ).mappings()
    workspace_by_user = {row["created_by_user_id"]: row["id"] for row in workspace_rows}
    assert set(workspace_by_user) == {10, 20}
    assert connection.execute(sa.select(workspaces.c.is_default)).scalars().all() == [
        True,
        True,
    ]

    loop_items = sa.Table("loop_items", sa.MetaData(), autoload_with=connection)
    workspace_by_node = dict(
        connection.execute(sa.select(loop_items.c.id, loop_items.c.workspace_id)).all()
    )
    for node_id in (
        "1001",
        "1002",
        "agent-1001",
        "agent-1002",
        "issue-human",
        "issue-project-agent",
        "issue-team",
    ):
        assert workspace_by_node[node_id] == workspace_by_user[10]
    for node_id in ("2001", "agent-2001", "issue-unassigned"):
        assert workspace_by_node[node_id] == workspace_by_user[20]

    executions = sa.Table(
        "loop_item_executions", sa.MetaData(), autoload_with=connection
    )
    workspace_by_execution = dict(
        connection.execute(sa.select(executions.c.id, executions.c.workspace_id)).all()
    )
    assert workspace_by_execution == {
        501: workspace_by_user[10],
        502: workspace_by_user[20],
    }


def _assert_member_backfill(connection: Connection) -> None:
    workspaces = sa.Table(
        "collaboration_workspaces", sa.MetaData(), autoload_with=connection
    )
    workspace_by_user = dict(
        connection.execute(
            sa.select(workspaces.c.created_by_user_id, workspaces.c.id)
        ).all()
    )
    members = sa.Table("resource_members", sa.MetaData(), autoload_with=connection)
    workspace_members = connection.execute(
        sa.select(
            members.c.resource_id,
            members.c.user_id,
            members.c.role,
        )
        .where(members.c.resource_type == "Workspace")
        .order_by(members.c.resource_id, members.c.user_id)
    ).all()
    assert workspace_members == [
        (workspace_by_user[10], 10, "Owner"),
        (workspace_by_user[10], 31, "Maintainer"),
        (workspace_by_user[20], 20, "Owner"),
        (workspace_by_user[20], 41, "Reporter"),
    ]


def _assert_assignment_backfill(connection: Connection) -> None:
    assignments = sa.Table("issue_assignments", sa.MetaData(), autoload_with=connection)
    rows = connection.execute(
        sa.select(
            assignments.c.loop_item_id,
            assignments.c.member_type,
            assignments.c.member_id,
            assignments.c.workflow_step,
            assignments.c.notify,
            assignments.c.trigger,
        ).order_by(assignments.c.loop_item_id)
    ).all()
    assert rows == [
        ("issue-human", "human", "31", "", False, "manual"),
        (
            "issue-project-agent",
            "agent",
            "agent-1001",
            "",
            False,
            "manual",
        ),
        ("issue-team", "agent", "900", "", False, "manual"),
    ]
    assert (
        connection.execute(
            sa.select(sa.func.count())
            .select_from(assignments)
            .where(assignments.c.loop_item_id == "issue-unassigned")
        ).scalar_one()
        == 0
    )

    human_assignment = (
        connection.execute(
            sa.select(assignments).where(assignments.c.loop_item_id == "issue-human")
        )
        .mappings()
        .one()
    )
    connection.execute(
        assignments.insert().values(
            workspace_id=human_assignment["workspace_id"],
            cloud_project_id="1001",
            loop_item_id="issue-human",
            member_type="agent",
            member_id="900",
            assigned_by_user_id=10,
            workflow_step="implementation",
            notify=True,
            trigger="manual",
            active_marker="active",
        )
    )
    assert (
        connection.execute(
            sa.select(sa.func.count())
            .select_from(assignments)
            .where(assignments.c.loop_item_id == "issue-human")
        ).scalar_one()
        == 2
    )


def _assert_shared_team_backfill(connection: Connection) -> None:
    workspaces = sa.Table(
        "collaboration_workspaces", sa.MetaData(), autoload_with=connection
    )
    owner_workspace_id = connection.execute(
        sa.select(workspaces.c.id).where(workspaces.c.created_by_user_id == 10)
    ).scalar_one()
    bindings = sa.Table(
        "workspace_agent_bindings", sa.MetaData(), autoload_with=connection
    )
    assert connection.execute(
        sa.select(
            bindings.c.workspace_id,
            bindings.c.team_id,
            bindings.c.owner_type,
            bindings.c.owner_user_id,
        ).where(bindings.c.team_id == 900)
    ).all() == [(owner_workspace_id, 900, "human", 10)]

    loop_items = sa.Table("loop_items", sa.MetaData(), autoload_with=connection)
    project_agents = connection.execute(
        sa.select(
            loop_items.c.id,
            loop_items.c.cloud_project_id,
            loop_items.c.workspace_id,
        )
        .where(loop_items.c.id.in_(["agent-1001", "agent-1002"]))
        .order_by(loop_items.c.id)
    ).all()
    assert project_agents == [
        ("agent-1001", "1001", owner_workspace_id),
        ("agent-1002", "1002", owner_workspace_id),
    ]
