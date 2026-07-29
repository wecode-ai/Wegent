"""add plugin restricted sharing metadata

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-07-29 16:20:00.000000
"""

import sqlalchemy as sa

from alembic import op

revision = "d9e0f1a2b3c4"
down_revision = "c8d9e0f1a2b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "plugins",
        sa.Column(
            "allow_copy",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "plugin_submissions",
        sa.Column(
            "purpose",
            sa.String(length=30),
            nullable=False,
            server_default="marketplace_publish",
        ),
    )


def downgrade() -> None:
    op.drop_column("plugin_submissions", "purpose")
    op.drop_column("plugins", "allow_copy")
