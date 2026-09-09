"""Add Smart app marketplace listing status.

Revision ID: e4a7b9c2d1f0
Revises: c2f8d4a6b901
Create Date: 2026-09-03 00:00:00+08:00
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e4a7b9c2d1f0"
down_revision: Union[str, Sequence[str], None] = "c2f8d4a6b901"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "smart_apps",
        sa.Column(
            "is_listed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
            comment="Whether the Smart app is listed in the WeWork marketplace",
        ),
    )


def downgrade() -> None:
    op.drop_column("smart_apps", "is_listed")
