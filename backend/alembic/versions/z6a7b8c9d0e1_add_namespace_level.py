# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add level column to namespace table

Revision ID: z6a7b8c9d0e1
Revises: y5z6a7b8c9d0
Create Date: 2025-02-10

This migration adds a 'level' column to the namespace table to support
organization-level groups. The level can be 'group' (default) or 'organization'.

Migration steps:
1. Add 'level' column with default 'group'
2. Create index on 'level' column
3. Set existing 'organization' namespace to level='organization'
4. Keep 'default' namespace unchanged (level remains NULL)
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "z6a7b8c9d0e1"
down_revision: Union[str, None] = "y5z6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def column_exists(table_name: str, column_name: str) -> bool:
    """Check if a column exists in the table."""
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT COUNT(*) FROM information_schema.columns "
            "WHERE table_name = :table_name AND column_name = :column_name AND table_schema = DATABASE()"
        ),
        {"table_name": table_name, "column_name": column_name},
    )
    return result.scalar() > 0


def index_exists(table_name: str, index_name: str) -> bool:
    """Check if an index exists on the table."""
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT COUNT(*) FROM information_schema.statistics "
            "WHERE table_name = :table_name AND index_name = :index_name AND table_schema = DATABASE()"
        ),
        {"table_name": table_name, "index_name": index_name},
    )
    return result.scalar() > 0


def upgrade() -> None:
    """Add level column to namespace table."""

    # Add level column if not exists
    if not column_exists("namespace", "level"):
        op.add_column(
            "namespace",
            sa.Column(
                "level",
                sa.String(20),
                nullable=True,
                server_default=sa.text("'group'"),
                comment="Group level: 'group' (default) or 'organization' (admin only)",
            ),
        )

    # Create index on level column if not exists
    if not index_exists("namespace", "idx_namespace_level"):
        op.create_index(
            "idx_namespace_level",
            "namespace",
            ["level"],
            unique=False,
        )

    # Set existing 'organization' namespace to level='organization'
    op.execute(
        sa.text(
            "UPDATE namespace SET level = 'organization' WHERE name = 'organization'"
        )
    )

    # Keep 'default' namespace with NULL level (represents personal namespace)
    # No action needed as new columns default to NULL


def downgrade() -> None:
    """Remove level column from namespace table."""

    # Drop index
    if index_exists("namespace", "idx_namespace_level"):
        op.drop_index("idx_namespace_level", table_name="namespace")

    # Drop column
    if column_exists("namespace", "level"):
        op.drop_column("namespace", "level")
