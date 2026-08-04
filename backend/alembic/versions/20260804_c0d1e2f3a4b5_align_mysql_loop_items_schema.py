"""Align MySQL loop items with the production sentinel schema.

Revision ID: c0d1e2f3a4b5
Revises: b9c0d1e2f3a4
Create Date: 2026-08-04
"""

from typing import Sequence, Union

from alembic import op
from app.db.mysql_loop_items_schema import (
    normalize_mysql_loop_items_schema,
    restore_nullable_mysql_loop_items_schema,
)

revision: str = "c0d1e2f3a4b5"
down_revision: Union[str, Sequence[str], None] = "b9c0d1e2f3a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Use sentinel values and generated unique projections on MySQL."""

    normalize_mysql_loop_items_schema(op.get_bind())


def downgrade() -> None:
    """Restore nullable columns, direct unique indexes, and foreign keys."""

    restore_nullable_mysql_loop_items_schema(op.get_bind())
