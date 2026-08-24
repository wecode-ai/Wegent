# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add Runtime capacity identity to loop item executions.

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
Create Date: 2026-08-15 18:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e0f1a2b3c4d5"
down_revision: Union[str, None] = "d9e0f1a2b3c4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "loop_item_executions",
        sa.Column(
            "runtime_instance_id",
            sa.String(length=100),
            nullable=False,
            server_default="",
        ),
    )
    op.create_index(
        "idx_exec_runtime_capacity",
        "loop_item_executions",
        ["executor_owner_user_id", "runtime_instance_id", "status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_exec_runtime_capacity", table_name="loop_item_executions")
    op.drop_column("loop_item_executions", "runtime_instance_id")
