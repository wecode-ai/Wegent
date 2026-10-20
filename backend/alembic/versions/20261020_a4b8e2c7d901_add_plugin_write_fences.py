"""Add durable commit fencing for Redis plugin coordination.

Revision ID: a4b8e2c7d901
Revises: f3a7c9e1b2d4
"""

import sqlalchemy as sa

from alembic import op

revision = "a4b8e2c7d901"
down_revision = "f3a7c9e1b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "plugin_write_fences",
        sa.Column("user_id", sa.BigInteger(), nullable=False, autoincrement=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    op.drop_table("plugin_write_fences")
