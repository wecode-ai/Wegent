# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add collaboration workspaces and issue assignments

Revision ID: b8e2c4f6a901
Revises: a6c4e2f8b901
Create Date: 2026-09-11
"""

import json
import uuid

import sqlalchemy as sa

from alembic import op

revision = "b8e2c4f6a901"
down_revision = "a6c4e2f8b901"
branch_labels = None
depends_on = None


def _bigint() -> sa.types.TypeEngine:
    return sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def _metadata(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _backfill() -> None:
    connection = op.get_bind()
    workspaces = sa.table(
        "collaboration_workspaces",
        sa.column("id", _bigint()),
        sa.column("public_id", sa.String(36)),
        sa.column("name", sa.String(100)),
        sa.column("description", sa.Text()),
        sa.column("created_by_user_id", sa.Integer()),
        sa.column("is_default", sa.Boolean()),
        sa.column("status", sa.String(16)),
        sa.column("version", sa.Integer()),
    )
    loop_items = sa.table(
        "loop_items",
        sa.column("id", sa.String(64)),
        sa.column("resource_type", sa.String(24)),
        sa.column("cloud_project_id", sa.String(64)),
        sa.column("workspace_id", _bigint()),
        sa.column("created_by_user_id", sa.Integer()),
        sa.column("assignee_user_id", sa.Integer()),
        sa.column("assignee_agent_id", sa.String(64)),
        sa.column("assignee_team_id", sa.Integer()),
        sa.column("device_id", sa.String(100)),
        sa.column("metadata", sa.JSON()),
        sa.column("status", sa.String(32)),
    )
    members = sa.table(
        "resource_members",
        sa.column("resource_type", sa.String(50)),
        sa.column("resource_id", _bigint()),
        sa.column("entity_type", sa.String(20)),
        sa.column("entity_id", sa.String(100)),
        sa.column("user_id", sa.Integer()),
        sa.column("role", sa.String(20)),
        sa.column("status", sa.String(20)),
    )
    assignments = sa.table(
        "issue_assignments",
        sa.column("workspace_id", _bigint()),
        sa.column("cloud_project_id", sa.String(64)),
        sa.column("loop_item_id", sa.String(64)),
        sa.column("member_type", sa.String(16)),
        sa.column("member_id", sa.String(128)),
        sa.column("assigned_by_user_id", sa.Integer()),
        sa.column("workflow_step", sa.String(128)),
        sa.column("notify", sa.Boolean()),
        sa.column("trigger", sa.String(24)),
        sa.column("active_marker", sa.String(16)),
    )
    agent_bindings = sa.table(
        "workspace_agent_bindings",
        sa.column("workspace_id", _bigint()),
        sa.column("team_id", sa.Integer()),
        sa.column("owner_type", sa.String(16)),
        sa.column("owner_user_id", sa.Integer()),
        sa.column("added_by_user_id", sa.Integer()),
    )
    environment_bindings = sa.table(
        "workspace_execution_environments",
        sa.column("workspace_id", _bigint()),
        sa.column("device_id", sa.Integer()),
        sa.column("owner_type", sa.String(16)),
        sa.column("owner_user_id", sa.Integer()),
        sa.column("added_by_user_id", sa.Integer()),
    )
    kinds = sa.table(
        "kinds",
        sa.column("id", sa.Integer()),
        sa.column("kind", sa.String(255)),
        sa.column("name", sa.String(255)),
        sa.column("user_id", sa.Integer()),
        sa.column("is_active", sa.Boolean()),
    )
    executions = sa.table(
        "loop_item_executions",
        sa.column("id", _bigint()),
        sa.column("cloud_project_id", sa.String(64)),
        sa.column("workspace_id", _bigint()),
    )

    projects = list(
        connection.execute(
            sa.select(
                loop_items.c.id,
                loop_items.c.created_by_user_id,
            ).where(loop_items.c.resource_type == "project")
        )
    )
    workspace_by_owner: dict[int, int] = {}
    workspace_by_project: dict[str, int] = {}
    for project in projects:
        owner_id = int(project.created_by_user_id or 0)
        workspace_id = workspace_by_owner.get(owner_id)
        if workspace_id is None:
            public_id = str(uuid.uuid4())
            connection.execute(
                workspaces.insert().values(
                    public_id=public_id,
                    name="默认协作空间",
                    description="",
                    created_by_user_id=owner_id,
                    is_default=True,
                    status="active",
                    version=1,
                )
            )
            workspace_id = int(
                connection.execute(
                    sa.select(workspaces.c.id).where(
                        workspaces.c.public_id == public_id
                    )
                ).scalar_one()
            )
            workspace_by_owner[owner_id] = workspace_id
            if owner_id:
                connection.execute(
                    members.insert().values(
                        resource_type="Workspace",
                        resource_id=workspace_id,
                        entity_type="user",
                        entity_id=str(owner_id),
                        user_id=owner_id,
                        role="Owner",
                        status="approved",
                    )
                )
        project_id = str(project.id)
        workspace_by_project[project_id] = workspace_id
        connection.execute(
            loop_items.update()
            .where(
                sa.or_(
                    loop_items.c.id == project_id,
                    loop_items.c.cloud_project_id == project_id,
                )
            )
            .values(workspace_id=workspace_id)
        )

    existing_workspace_members = {
        (int(row.resource_id), str(row.entity_id))
        for row in connection.execute(
            sa.select(members.c.resource_id, members.c.entity_id).where(
                members.c.resource_type == "Workspace"
            )
        )
    }
    project_members = connection.execute(
        sa.select(
            members.c.resource_id,
            members.c.entity_id,
            members.c.user_id,
            members.c.role,
            members.c.status,
        ).where(
            members.c.resource_type == "CloudProject",
            members.c.entity_type == "user",
            members.c.status == "approved",
        )
    )
    for member in project_members:
        workspace_id = workspace_by_project.get(str(member.resource_id))
        identity = (workspace_id or 0, str(member.entity_id))
        if workspace_id is None or identity in existing_workspace_members:
            continue
        connection.execute(
            members.insert().values(
                resource_type="Workspace",
                resource_id=workspace_id,
                entity_type="user",
                entity_id=str(member.entity_id),
                user_id=int(member.user_id or member.entity_id),
                role="Reporter" if member.role == "RestrictedAnalyst" else member.role,
                status="approved",
            )
        )
        existing_workspace_members.add(identity)

    for execution in connection.execute(
        sa.select(executions.c.id, executions.c.cloud_project_id)
    ):
        workspace_id = workspace_by_project.get(str(execution.cloud_project_id))
        if workspace_id is not None:
            connection.execute(
                executions.update()
                .where(executions.c.id == execution.id)
                .values(workspace_id=workspace_id)
            )

    active_assignment_keys: set[tuple[str, str, str, str]] = set()
    tasks = list(
        connection.execute(
            sa.select(
                loop_items.c.id,
                loop_items.c.cloud_project_id,
                loop_items.c.workspace_id,
                loop_items.c.created_by_user_id,
                loop_items.c.assignee_user_id,
                loop_items.c.assignee_agent_id,
                loop_items.c.assignee_team_id,
            ).where(loop_items.c.resource_type == "task")
        )
    )
    for item in tasks:
        target: tuple[str, str] | None = None
        if item.assignee_agent_id:
            target = ("agent", str(item.assignee_agent_id))
        elif item.assignee_team_id:
            target = ("agent", str(item.assignee_team_id))
        elif item.assignee_user_id:
            target = ("human", str(item.assignee_user_id))
        if target is None:
            continue
        key = (str(item.id), target[0], target[1], "")
        if key in active_assignment_keys:
            continue
        connection.execute(
            assignments.insert().values(
                workspace_id=item.workspace_id,
                cloud_project_id=str(item.cloud_project_id),
                loop_item_id=str(item.id),
                member_type=target[0],
                member_id=target[1],
                assigned_by_user_id=int(item.created_by_user_id or 0),
                workflow_step="",
                notify=False,
                trigger="manual",
                active_marker="active",
            )
        )
        active_assignment_keys.add(key)

    device_by_owner_and_name = {
        (int(row.user_id or 0), str(row.name)): int(row.id)
        for row in connection.execute(
            sa.select(
                kinds.c.id,
                kinds.c.user_id,
                kinds.c.name,
            ).where(kinds.c.kind == "Device", kinds.c.is_active.is_(True))
        )
    }
    agent_keys: set[tuple[int, int]] = set()
    environment_keys: set[tuple[int, int]] = set()
    agents = connection.execute(
        sa.select(
            loop_items.c.cloud_project_id,
            loop_items.c.created_by_user_id,
            loop_items.c.device_id,
            loop_items.c.metadata,
        ).where(loop_items.c.resource_type == "chat_agent")
    )
    for agent in agents:
        workspace_id = workspace_by_project.get(str(agent.cloud_project_id))
        if workspace_id is None:
            continue
        owner_id = int(agent.created_by_user_id or 0)
        metadata = _metadata(agent.metadata)
        team_id = metadata.get("wegent_team_id")
        try:
            normalized_team_id = int(team_id) if team_id is not None else None
        except (TypeError, ValueError):
            normalized_team_id = None
        if normalized_team_id:
            key = (workspace_id, normalized_team_id)
            if key not in agent_keys:
                connection.execute(
                    agent_bindings.insert().values(
                        workspace_id=workspace_id,
                        team_id=normalized_team_id,
                        owner_type="human",
                        owner_user_id=owner_id or None,
                        added_by_user_id=owner_id,
                    )
                )
                agent_keys.add(key)
        if agent.device_id:
            device_id = device_by_owner_and_name.get((owner_id, str(agent.device_id)))
            key = (workspace_id, device_id or 0)
            if device_id and key not in environment_keys:
                connection.execute(
                    environment_bindings.insert().values(
                        workspace_id=workspace_id,
                        device_id=device_id,
                        owner_type="human",
                        owner_user_id=owner_id or None,
                        added_by_user_id=owner_id,
                    )
                )
                environment_keys.add(key)


def upgrade() -> None:
    bigint = _bigint()
    op.create_table(
        "collaboration_workspaces",
        sa.Column("id", bigint, primary_key=True, autoincrement=True),
        sa.Column("public_id", sa.String(36), nullable=False, unique=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index(
        "idx_collaboration_workspaces_owner_status",
        "collaboration_workspaces",
        ["created_by_user_id", "status"],
    )
    op.add_column("loop_items", sa.Column("workspace_id", bigint, nullable=True))
    op.create_index("ix_loop_items_workspace_id", "loop_items", ["workspace_id"])
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_loop_items_workspace_id",
            "loop_items",
            "collaboration_workspaces",
            ["workspace_id"],
            ["id"],
            ondelete="CASCADE",
        )
    op.add_column(
        "loop_item_executions",
        sa.Column("workspace_id", bigint, nullable=True),
    )
    op.create_index(
        "idx_exec_workspace_status",
        "loop_item_executions",
        ["workspace_id", "status"],
    )
    op.create_table(
        "workspace_agent_bindings",
        sa.Column("id", bigint, primary_key=True, autoincrement=True),
        sa.Column("workspace_id", bigint, nullable=False),
        sa.Column("team_id", sa.Integer(), nullable=False),
        sa.Column("owner_type", sa.String(16), nullable=False, server_default="human"),
        sa.Column("owner_user_id", sa.Integer(), nullable=True),
        sa.Column("added_by_user_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["collaboration_workspaces.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["team_id"], ["kinds.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "workspace_id", "team_id", name="uniq_workspace_agent_team"
        ),
    )
    op.create_index(
        "idx_workspace_agents_owner",
        "workspace_agent_bindings",
        ["owner_type", "owner_user_id"],
    )
    op.create_table(
        "workspace_execution_environments",
        sa.Column("id", bigint, primary_key=True, autoincrement=True),
        sa.Column("workspace_id", bigint, nullable=False),
        sa.Column("device_id", sa.Integer(), nullable=False),
        sa.Column("owner_type", sa.String(16), nullable=False, server_default="human"),
        sa.Column("owner_user_id", sa.Integer(), nullable=True),
        sa.Column("added_by_user_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["collaboration_workspaces.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["device_id"], ["kinds.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "workspace_id",
            "device_id",
            name="uniq_workspace_execution_environment_device",
        ),
    )
    op.create_index(
        "idx_workspace_execution_environments_workspace",
        "workspace_execution_environments",
        ["workspace_id", "created_at"],
    )
    op.create_index(
        "idx_workspace_execution_environments_owner",
        "workspace_execution_environments",
        ["owner_type", "owner_user_id"],
    )
    op.create_table(
        "issue_assignments",
        sa.Column("id", bigint, primary_key=True, autoincrement=True),
        sa.Column("workspace_id", bigint, nullable=True),
        sa.Column("cloud_project_id", sa.String(64), nullable=False),
        sa.Column("loop_item_id", sa.String(64), nullable=False),
        sa.Column("member_type", sa.String(16), nullable=False),
        sa.Column("member_id", sa.String(128), nullable=False),
        sa.Column("assigned_by_user_id", sa.Integer(), nullable=False),
        sa.Column("workflow_step", sa.String(128), nullable=False, server_default=""),
        sa.Column("notify", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("comment_id", sa.String(64), nullable=True),
        sa.Column("trigger", sa.String(24), nullable=False, server_default="manual"),
        sa.Column(
            "active_marker", sa.String(16), nullable=True, server_default="active"
        ),
        sa.Column(
            "removed_by_user_id", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("removed_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["collaboration_workspaces.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["cloud_project_id"], ["loop_items.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["loop_item_id"], ["loop_items.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "loop_item_id",
            "member_type",
            "member_id",
            "workflow_step",
            "active_marker",
            name="uniq_active_issue_assignment",
        ),
    )
    op.create_index(
        "idx_issue_assignments_project_active",
        "issue_assignments",
        ["cloud_project_id", "active_marker"],
    )
    op.create_index(
        "idx_issue_assignments_issue_active",
        "issue_assignments",
        ["loop_item_id", "active_marker"],
    )
    op.create_index(
        "idx_issue_assignments_member_active",
        "issue_assignments",
        ["member_type", "member_id", "active_marker"],
    )
    op.create_index(
        "idx_issue_assignments_comment",
        "issue_assignments",
        ["comment_id"],
    )
    _backfill()


def downgrade() -> None:
    resource_members = sa.table(
        "resource_members",
        sa.column("resource_type", sa.String(50)),
    )
    op.execute(
        resource_members.delete().where(resource_members.c.resource_type == "Workspace")
    )
    op.drop_table("issue_assignments")
    op.drop_table("workspace_execution_environments")
    op.drop_table("workspace_agent_bindings")
    op.drop_index("idx_exec_workspace_status", table_name="loop_item_executions")
    op.drop_column("loop_item_executions", "workspace_id")
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("loop_items") as batch_op:
            batch_op.drop_index("ix_loop_items_workspace_id")
            batch_op.drop_column("workspace_id")
    else:
        op.drop_constraint(
            "fk_loop_items_workspace_id", "loop_items", type_="foreignkey"
        )
        op.drop_index("ix_loop_items_workspace_id", table_name="loop_items")
        op.drop_column("loop_items", "workspace_id")
    op.drop_table("collaboration_workspaces")
