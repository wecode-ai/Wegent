# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index active device assignments by owner and executor.

Revision ID: a2d59b84f731
Revises: f3a7c9e1b2d4
"""

from alembic import op

revision = "a2d59b84f731"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_subtasks_user_executor_status",
        "subtasks",
        ["user_id", "executor_name", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_subtasks_user_executor_status", table_name="subtasks")
