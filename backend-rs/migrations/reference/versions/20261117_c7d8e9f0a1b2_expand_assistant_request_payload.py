"""Retain durable assistant commands and evidence beyond the legacy TEXT limit.

Revision ID: c7d8e9f0a1b2
Revises: b1c2d3e4f5a6
Create Date: 2026-11-17
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.mysql import LONGTEXT

revision = "c7d8e9f0a1b2"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "mysql":
        op.alter_column(
            "loop_item_executions",
            "execution_payload",
            existing_type=sa.Text(),
            type_=LONGTEXT(),
            existing_nullable=False,
        )


def downgrade() -> None:
    # Older writers can read LONGTEXT. Narrowing would destroy accepted commands
    # or evidence, so schema rollback deliberately preserves the wider column.
    pass
