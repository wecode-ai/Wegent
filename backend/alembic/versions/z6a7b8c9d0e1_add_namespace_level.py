# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add level column to namespace table

Revision ID: z6a7b8c9d0e1
Revises: f1e2d3c4b5a6
Create Date: 2025-02-10

This migration adds a 'level' column to the namespace table to support
organization-level groups. The level can be 'group' (default) or 'organization'.

Migration steps:
1. Add 'level' column with default 'group'
2. Create index on 'level' column
3. Set existing 'organization' namespace to level='organization'
4. Keep 'default' namespace unchanged (level remains NULL)
5. Fix collation for all character columns to utf8mb4_0900_ai_ci
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "z6a7b8c9d0e1"
down_revision: Union[str, None] = "f1e2d3c4b5a6"
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
    """Add level column to namespace table and ensure organization namespace exists."""
    conn = op.get_bind()

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

    # Check if 'organization' namespace exists
    result = conn.execute(
        sa.text("SELECT id, level FROM namespace WHERE name = 'organization'")
    )
    row = result.fetchone()

    if row is None:
        # Create 'organization' namespace if it doesn't exist
        # First, try to get the first admin user as the owner
        admin_result = conn.execute(
            sa.text("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
        )
        admin_row = admin_result.fetchone()

        if admin_row is not None:
            owner_user_id = admin_row[0]
        else:
            # If no admin user exists, use the first user
            user_result = conn.execute(
                sa.text("SELECT id FROM users ORDER BY id LIMIT 1")
            )
            user_row = user_result.fetchone()
            owner_user_id = (
                user_row[0] if user_row else 1
            )  # Default to 1 if no users exist

        conn.execute(
            sa.text(
                """
                INSERT INTO namespace (name, display_name, owner_user_id, level, visibility, description, is_active, created_at, updated_at)
                VALUES ('organization', 'Organization', :owner_user_id, 'organization', 'private', 'Organization level knowledge base', 1, NOW(), NOW())
                """
            ),
            {"owner_user_id": owner_user_id},
        )
    elif row[1] != "organization":
        # Update level to 'organization' if it's not already set
        conn.execute(
            sa.text(
                "UPDATE namespace SET level = 'organization' WHERE name = 'organization'"
            )
        )

    # Keep 'default' namespace with NULL level (represents personal namespace)
    # No action needed as new columns default to NULL

    # Fix collation for namespace table to use utf8mb4_0900_ai_ci
    conn.execute(
        sa.text(
            """
            ALTER TABLE namespace 
            MODIFY COLUMN name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
            MODIFY COLUMN display_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
            MODIFY COLUMN description TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
            MODIFY COLUMN visibility VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
            MODIFY COLUMN level VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
            """
        )
    )

    # Fix collation for kinds table to use utf8mb4_0900_ai_ci
    conn.execute(
        sa.text(
            """
            ALTER TABLE kinds 
            MODIFY COLUMN kind VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
            MODIFY COLUMN name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
            MODIFY COLUMN namespace VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
            """
        )
    )


def downgrade() -> None:
    """Remove level column from namespace table."""

    # Drop index
    if index_exists("namespace", "idx_namespace_level"):
        op.drop_index("idx_namespace_level", table_name="namespace")

    # Drop column
    if column_exists("namespace", "level"):
        op.drop_column("namespace", "level")
