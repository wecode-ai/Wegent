# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Add external event binding routing columns to loop items.

The provider and opaque reference columns let a delivery-derived external
reference route an inbound event to the card that owns it.

Revision ID: b4e7dfa1ef70
Revises: f82c5d1a9e37
Create Date: 2026-08-21
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "b4e7dfa1ef70"
down_revision: Union[str, Sequence[str], None] = "f82c5d1a9e37"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "loop_items",
        sa.Column("provider", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "loop_items",
        sa.Column("opaque_ref", sa.String(length=512), nullable=True),
    )
    op.create_index(
        "idx_loop_items_provider_ref",
        "loop_items",
        ["provider", "opaque_ref"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_loop_items_provider_ref", table_name="loop_items")
    op.drop_column("loop_items", "opaque_ref")
    op.drop_column("loop_items", "provider")
