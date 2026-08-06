# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Add a subtask status-change cursor for task run metric reconciliation.

Revision ID: e1f2a3b4c5d6
Revises: c0d1e2f3a4b5
Create Date: 2026-08-06
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, Sequence[str], None] = "c0d1e2f3a4b5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX_NAME = "ix_subtasks_role_status_changed_at_id"
OLD_CREATED_INDEX_NAME = "ix_subtasks_role_created_at_status"
CREATED_CURSOR_INDEX_NAME = "ix_subtasks_role_created_at_id"


def upgrade() -> None:
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("subtasks")
    }
    if "status_changed_at" not in columns:
        op.add_column(
            "subtasks",
            sa.Column("status_changed_at", sa.DateTime(), nullable=True),
        )

    indexes = {
        index["name"] for index in sa.inspect(op.get_bind()).get_indexes("subtasks")
    }
    if INDEX_NAME not in indexes:
        op.create_index(
            INDEX_NAME,
            "subtasks",
            ["role", "status_changed_at", "id"],
        )
    if OLD_CREATED_INDEX_NAME in indexes:
        op.drop_index(OLD_CREATED_INDEX_NAME, table_name="subtasks")
    if CREATED_CURSOR_INDEX_NAME not in indexes:
        op.create_index(
            CREATED_CURSOR_INDEX_NAME,
            "subtasks",
            ["role", "created_at", "id"],
        )


def downgrade() -> None:
    indexes = {
        index["name"] for index in sa.inspect(op.get_bind()).get_indexes("subtasks")
    }
    if INDEX_NAME in indexes:
        op.drop_index(INDEX_NAME, table_name="subtasks")

    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("subtasks")
    }
    if "status_changed_at" in columns:
        op.drop_column("subtasks", "status_changed_at")
