# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Add an index for task run statistics queries.

Revision ID: c0d1e2f3a4b5
Revises: b9c0d1e2f3a4
Create Date: 2026-08-05
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "c0d1e2f3a4b5"
down_revision: Union[str, Sequence[str], None] = "b9c0d1e2f3a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX_NAME = "ix_subtasks_role_created_at_status"


def upgrade() -> None:
    existing_indexes = {
        index["name"] for index in sa.inspect(op.get_bind()).get_indexes("subtasks")
    }
    if INDEX_NAME not in existing_indexes:
        op.create_index(
            INDEX_NAME,
            "subtasks",
            ["role", "created_at", "status"],
        )


def downgrade() -> None:
    existing_indexes = {
        index["name"] for index in sa.inspect(op.get_bind()).get_indexes("subtasks")
    }
    if INDEX_NAME in existing_indexes:
        op.drop_index(INDEX_NAME, table_name="subtasks")
