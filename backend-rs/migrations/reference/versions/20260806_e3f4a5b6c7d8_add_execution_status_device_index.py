"""Add status-first index for queue consumer device lookups.

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
"""

import sqlalchemy as sa

from alembic import op

revision = "e3f4a5b6c7d8"
down_revision = "d2e3f4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "idx_exec_status_device",
        "loop_item_executions",
        ["status", "execution_device_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_exec_status_device", table_name="loop_item_executions")
