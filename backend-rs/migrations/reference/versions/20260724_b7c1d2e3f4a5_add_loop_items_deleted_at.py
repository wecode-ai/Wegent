"""Add soft-delete timestamp to loop items.

Revision ID: b7c1d2e3f4a5
Revises: a6d94c3e5217
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "b7c1d2e3f4a5"
down_revision: Union[str, None] = "a6d94c3e5217"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("loop_items", sa.Column("deleted_at", sa.DateTime(), nullable=True))
    op.create_index("ix_loop_items_deleted_at", "loop_items", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_loop_items_deleted_at", table_name="loop_items")
    op.drop_column("loop_items", "deleted_at")
