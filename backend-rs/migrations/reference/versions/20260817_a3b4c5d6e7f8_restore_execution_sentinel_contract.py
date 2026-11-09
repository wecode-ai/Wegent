# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Restore NOT NULL sentinel storage for optional board execution identifiers.

Revision ID: a3b4c5d6e7f8
Revises: f1a2b3c4d5e6
Create Date: 2026-08-17
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from shared.models.db.types import big_integer_id_type

revision: str = "a3b4c5d6e7f8"
down_revision: Union[str, Sequence[str], None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _drop_foreign_key(table_name: str, column_name: str) -> None:
    inspector = sa.inspect(op.get_bind())
    for foreign_key in inspector.get_foreign_keys(table_name):
        if foreign_key.get("constrained_columns") == [column_name]:
            op.drop_constraint(foreign_key["name"], table_name, type_="foreignkey")


def _set_not_null_sentinel(
    table_name: str,
    column_name: str,
    column_type: sa.types.TypeEngine,
) -> None:
    op.execute(
        sa.text(
            f"UPDATE {table_name} SET {column_name} = 0 " f"WHERE {column_name} IS NULL"
        )
    )
    op.alter_column(
        table_name,
        column_name,
        existing_type=column_type,
        nullable=False,
        server_default="0",
    )


def _restore_nullable_foreign_key(
    *,
    table_name: str,
    column_name: str,
    column_type: sa.types.TypeEngine,
    constraint_name: str,
    target_table: str,
) -> None:
    op.alter_column(
        table_name,
        column_name,
        existing_type=column_type,
        nullable=True,
        server_default=None,
    )
    op.execute(
        sa.text(
            f"UPDATE {table_name} SET {column_name} = NULL " f"WHERE {column_name} = 0"
        )
    )
    op.create_foreign_key(
        constraint_name,
        table_name,
        target_table,
        [column_name],
        ["id"],
        ondelete="SET NULL",
    )


def upgrade() -> None:
    columns = (
        ("loop_items", "assignee_team_id", sa.Integer()),
        ("loop_item_executions", "team_id", sa.Integer()),
        ("loop_item_executions", "backend_task_id", big_integer_id_type()),
    )
    for table_name, column_name, column_type in columns:
        _drop_foreign_key(table_name, column_name)
        _set_not_null_sentinel(table_name, column_name, column_type)


def downgrade() -> None:
    _restore_nullable_foreign_key(
        table_name="loop_items",
        column_name="assignee_team_id",
        column_type=sa.Integer(),
        constraint_name="fk_loop_items_assignee_team_id_kinds",
        target_table="kinds",
    )
    _restore_nullable_foreign_key(
        table_name="loop_item_executions",
        column_name="team_id",
        column_type=sa.Integer(),
        constraint_name="fk_loop_item_executions_team_id_kinds",
        target_table="kinds",
    )
    _restore_nullable_foreign_key(
        table_name="loop_item_executions",
        column_name="backend_task_id",
        column_type=big_integer_id_type(),
        constraint_name="fk_loop_item_executions_backend_task_id_tasks",
        target_table="tasks",
    )
