# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add Wegent Team assignment to existing board execution tables.

Revision ID: f1a2b3c4d5e6
Revises: e0f1a2b3c4d5
Create Date: 2026-08-15 20:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, None] = "e0f1a2b3c4d5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ensure_column(
    table_name: str,
    column_name: str,
    column_type: sa.types.TypeEngine,
) -> None:
    inspector = sa.inspect(op.get_bind())
    existing = next(
        (
            column
            for column in inspector.get_columns(table_name)
            if column["name"] == column_name
        ),
        None,
    )
    if existing is None:
        op.add_column(
            table_name,
            sa.Column(column_name, column_type, nullable=True),
        )
        return

    op.alter_column(
        table_name,
        column_name,
        existing_type=existing["type"],
        type_=column_type,
        existing_nullable=existing["nullable"],
        nullable=True,
    )


def _ensure_foreign_key(
    name: str,
    source_table: str,
    target_table: str,
    source_column: str,
    target_column: str,
) -> None:
    inspector = sa.inspect(op.get_bind())
    for foreign_key in inspector.get_foreign_keys(source_table):
        if (
            foreign_key.get("constrained_columns") == [source_column]
            and foreign_key.get("referred_table") == target_table
            and foreign_key.get("referred_columns") == [target_column]
        ):
            if foreign_key.get("name") == name:
                return
            op.drop_constraint(foreign_key["name"], source_table, type_="foreignkey")
            break
    op.create_foreign_key(
        name,
        source_table,
        target_table,
        [source_column],
        [target_column],
        ondelete="SET NULL",
    )


def _ensure_index(name: str, table_name: str, columns: list[str]) -> None:
    inspector = sa.inspect(op.get_bind())
    for index in inspector.get_indexes(table_name):
        if index.get("name") == name:
            return
    op.create_index(name, table_name, columns, unique=False)


def upgrade() -> None:
    # MySQL DDL is non-transactional. These ensure operations also repair a
    # database left midway through this revision by an interrupted deployment.
    _ensure_column("loop_items", "assignee_team_id", sa.Integer())
    _ensure_foreign_key(
        "fk_loop_items_assignee_team_id_kinds",
        "loop_items",
        "kinds",
        "assignee_team_id",
        "id",
    )
    _ensure_index(
        "ix_loop_items_assignee_team_id",
        "loop_items",
        ["assignee_team_id"],
    )
    _ensure_column(
        "loop_item_executions",
        "team_id",
        sa.Integer(),
    )
    _ensure_column(
        "loop_item_executions",
        "backend_task_id",
        sa.BigInteger(),
    )
    _ensure_foreign_key(
        "fk_loop_item_executions_team_id_kinds",
        "loop_item_executions",
        "kinds",
        "team_id",
        "id",
    )
    _ensure_foreign_key(
        "fk_loop_item_executions_backend_task_id_tasks",
        "loop_item_executions",
        "tasks",
        "backend_task_id",
        "id",
    )
    _ensure_index(
        "idx_exec_team_status",
        "loop_item_executions",
        ["team_id", "status"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_loop_item_executions_backend_task_id_tasks",
        "loop_item_executions",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_loop_item_executions_team_id_kinds",
        "loop_item_executions",
        type_="foreignkey",
    )
    op.drop_index("idx_exec_team_status", table_name="loop_item_executions")
    op.drop_column("loop_item_executions", "backend_task_id")
    op.drop_column("loop_item_executions", "team_id")
    op.drop_constraint(
        "fk_loop_items_assignee_team_id_kinds",
        "loop_items",
        type_="foreignkey",
    )
    op.drop_index("ix_loop_items_assignee_team_id", table_name="loop_items")
    op.drop_column("loop_items", "assignee_team_id")
