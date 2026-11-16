"""Allow Wework notifications without a navigation target.

Revision ID: a6c9d1e4f3b2
Revises: f5b8c0d3e2a1
"""

import sqlalchemy as sa

from alembic import op

revision = "a6c9d1e4f3b2"
down_revision = "f5b8c0d3e2a1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("wework_notifications") as batch_op:
        batch_op.alter_column("url", existing_type=sa.String(2048), nullable=True)
    op.execute("UPDATE wework_notifications SET url = NULL WHERE url = ''")


def downgrade() -> None:
    # Preserve user messages while restoring the previous non-null column.
    op.execute("UPDATE wework_notifications SET url = '' WHERE url IS NULL")
    with op.batch_alter_table("wework_notifications") as batch_op:
        batch_op.alter_column("url", existing_type=sa.String(2048), nullable=False)
