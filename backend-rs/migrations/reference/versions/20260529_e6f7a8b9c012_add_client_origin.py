# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add client origin columns

Revision ID: e6f7a8b9c012
Revises: 9d4be4601172
Create Date: 2026-05-29
"""

import sqlalchemy as sa

from alembic import op

revision = "e6f7a8b9c012"
down_revision = "9d4be4601172"
branch_labels = None
depends_on = None


def _column_names(table_name: str) -> set[str]:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    return {column["name"] for column in inspector.get_columns(table_name)}


def _index_names(table_name: str) -> set[str]:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    return {index["name"] for index in inspector.get_indexes(table_name)}


def upgrade() -> None:
    """Add client origin columns and indexes."""
    if "client_origin" not in _column_names("projects"):
        op.add_column(
            "projects",
            sa.Column(
                "client_origin",
                sa.String(length=32),
                nullable=False,
                server_default="frontend",
                comment="Client surface that owns this project, e.g. frontend or wework",
            ),
        )

    if "client_origin" not in _column_names("tasks"):
        op.add_column(
            "tasks",
            sa.Column(
                "client_origin",
                sa.String(length=32),
                nullable=False,
                server_default="frontend",
                comment="Client surface that owns this task, e.g. frontend or wework",
            ),
        )

    project_indexes = _index_names("projects")
    if "ix_projects_user_origin_active" not in project_indexes:
        op.create_index(
            "ix_projects_user_origin_active",
            "projects",
            ["user_id", "client_origin", "is_active"],
        )

    task_indexes = _index_names("tasks")
    if "ix_tasks_user_origin_active_project" not in task_indexes:
        op.create_index(
            "ix_tasks_user_origin_active_project",
            "tasks",
            ["user_id", "client_origin", "is_active", "project_id"],
        )


def downgrade() -> None:
    """Remove client origin columns and indexes."""
    task_indexes = _index_names("tasks")
    if "ix_tasks_user_origin_active_project" in task_indexes:
        op.drop_index("ix_tasks_user_origin_active_project", table_name="tasks")

    project_indexes = _index_names("projects")
    if "ix_projects_user_origin_active" in project_indexes:
        op.drop_index("ix_projects_user_origin_active", table_name="projects")

    if "client_origin" in _column_names("tasks"):
        op.drop_column("tasks", "client_origin")

    if "client_origin" in _column_names("projects"):
        op.drop_column("projects", "client_origin")
