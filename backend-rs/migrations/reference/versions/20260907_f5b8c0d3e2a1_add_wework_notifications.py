"""Add the persistent Wework inbox.

Revision ID: f5b8c0d3e2a1
Revises: e4a7b9c2d1f0
"""

import sqlalchemy as sa

from alembic import op

revision = "f5b8c0d3e2a1"
down_revision = "e4a7b9c2d1f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wework_notifications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("actor_user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(64), nullable=False),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("url", sa.String(2048), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("read_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_wework_notifications_inbox",
        "wework_notifications",
        ["user_id", "created_at", "id"],
    )


def downgrade() -> None:
    op.drop_table("wework_notifications")
