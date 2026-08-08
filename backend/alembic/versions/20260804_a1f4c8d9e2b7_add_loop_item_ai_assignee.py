"""Add an AI assignee to project work items.

Revision ID: a1f4c8d9e2b7
Revises: c0d1e2f3a4b5
"""

import sqlalchemy as sa

from alembic import op

revision = "a1f4c8d9e2b7"
down_revision = "c0d1e2f3a4b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "loop_items",
        sa.Column("assignee_agent_id", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "ix_loop_items_assignee_agent_id",
        "loop_items",
        ["assignee_agent_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_loop_items_assignee_agent_id", table_name="loop_items")
    op.drop_column("loop_items", "assignee_agent_id")
