# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Move project visibility to grants and protect legacy public issues."""

from datetime import datetime

import sqlalchemy as sa

from alembic import op

revision = "e6f1a2b3c4d5"
down_revision = "d2b9e7c4a6f1"
branch_labels = None
depends_on = None

nodes = sa.table(
    "loop_items",
    sa.column("id", sa.String),
    sa.column("resource_type", sa.String),
    sa.column("cloud_project_id", sa.String),
    sa.column("metadata", sa.JSON),
)
members = sa.table(
    "resource_members",
    sa.column("id", sa.Integer),
    sa.column("resource_type", sa.String),
    sa.column("resource_id", sa.BigInteger),
    sa.column("entity_type", sa.String),
    sa.column("entity_id", sa.String),
    sa.column("role", sa.String),
    sa.column("status", sa.String),
    sa.column("user_id", sa.Integer),
    sa.column("requested_at", sa.DateTime),
    sa.column("created_at", sa.DateTime),
    sa.column("updated_at", sa.DateTime),
)


def upgrade() -> None:
    connection = op.get_bind()
    projects = connection.execute(
        sa.select(nodes.c.id, nodes.c.metadata).where(
            nodes.c.resource_type == "project"
        )
    ).all()
    for project_id, raw_metadata in projects:
        metadata = dict(raw_metadata or {})
        legacy_visibility = metadata.pop("visibility", "private")
        migration = {"visibility": legacy_visibility}
        if legacy_visibility in {"public", "public_restricted"}:
            migration["default_issue_security"] = metadata.get("default_issue_security")
            metadata["default_issue_security"] = "related"
            connection.execute(
                members.insert().values(
                    resource_type="CloudProject",
                    resource_id=int(project_id),
                    entity_type="authenticated_users",
                    entity_id="*",
                    role="Viewer",
                    status="approved",
                    user_id=0,
                    requested_at=datetime.utcnow(),
                    created_at=datetime.utcnow(),
                    updated_at=datetime.utcnow(),
                )
            )
            tasks = connection.execute(
                sa.select(nodes.c.id, nodes.c.metadata).where(
                    nodes.c.resource_type == "task",
                    nodes.c.cloud_project_id == str(project_id),
                )
            ).all()
            migrated_issue_ids = []
            for task_id, raw_task_metadata in tasks:
                task_metadata = dict(raw_task_metadata or {})
                if "security_level" not in task_metadata:
                    migrated_issue_ids.append(task_id)
                    task_metadata["security_level"] = "related"
                    connection.execute(
                        nodes.update()
                        .where(nodes.c.id == task_id)
                        .values(metadata=task_metadata)
                    )
            migration["issue_ids"] = migrated_issue_ids
        reporter_rows = connection.execute(
            sa.select(members.c.id, members.c.role).where(
                members.c.resource_type == "CloudProject",
                members.c.resource_id == int(project_id),
                members.c.role.in_(("Reporter", "RestrictedAnalyst")),
            )
        ).all()
        if reporter_rows:
            migration["member_roles"] = {
                str(member_id): role for member_id, role in reporter_rows
            }
            connection.execute(
                members.update()
                .where(members.c.id.in_([row[0] for row in reporter_rows]))
                .values(role="Viewer")
            )
        metadata["permission_migration"] = migration
        connection.execute(
            nodes.update().where(nodes.c.id == project_id).values(metadata=metadata)
        )


def downgrade() -> None:
    connection = op.get_bind()
    projects = connection.execute(
        sa.select(nodes.c.id, nodes.c.metadata).where(
            nodes.c.resource_type == "project"
        )
    ).all()
    for project_id, raw_metadata in projects:
        metadata = dict(raw_metadata or {})
        migration = metadata.pop("permission_migration", None)
        if not isinstance(migration, dict):
            continue
        legacy_visibility = migration.get("visibility", "private")
        metadata["visibility"] = legacy_visibility
        if legacy_visibility in {"public", "public_restricted"}:
            prior_default = migration.get("default_issue_security")
            if prior_default is None:
                metadata.pop("default_issue_security", None)
            else:
                metadata["default_issue_security"] = prior_default
            issue_ids = migration.get("issue_ids", [])
            tasks = connection.execute(
                sa.select(nodes.c.id, nodes.c.metadata).where(
                    nodes.c.resource_type == "task",
                    nodes.c.cloud_project_id == str(project_id),
                    nodes.c.id.in_(issue_ids),
                )
            ).all()
            for task_id, raw_task_metadata in tasks:
                task_metadata = dict(raw_task_metadata or {})
                if task_metadata.get("security_level") == "related":
                    task_metadata.pop("security_level", None)
                    connection.execute(
                        nodes.update()
                        .where(nodes.c.id == task_id)
                        .values(metadata=task_metadata)
                    )
        connection.execute(
            members.delete().where(
                members.c.resource_type == "CloudProject",
                members.c.resource_id == int(project_id),
                members.c.entity_type == "authenticated_users",
                members.c.entity_id == "*",
            )
        )
        member_roles = migration.get("member_roles", {})
        for member_id, role in member_roles.items():
            connection.execute(
                members.update().where(members.c.id == int(member_id)).values(role=role)
            )
        connection.execute(
            nodes.update().where(nodes.c.id == project_id).values(metadata=metadata)
        )
