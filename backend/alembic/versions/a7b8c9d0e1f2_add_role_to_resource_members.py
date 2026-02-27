# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add role column to resource_members table.

This migration:
1. Adds role column to resource_members table
2. Migrates existing permission_level data to role
3. Updates permission_level comment to indicate deprecation

Revision ID: a7b8c9d0e1f2
Revises: z6a7b8c9d0e1
Create Date: 2025-02-25

Migration rules:
- permission_level = 'view'/'VIEW' -> role = 'Reporter'
- permission_level = 'edit'/'EDIT' -> role = 'Developer'
- permission_level = 'manage'/'MANAGE' -> role = 'Maintainer'
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.engine import Connection

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, Sequence[str], None] = "z6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def table_exists(conn: Connection, table_name: str) -> bool:
    """Check if a table exists using SQLAlchemy Inspector (DB-agnostic)."""
    inspector = inspect(conn)
    return table_name in inspector.get_table_names()


def column_exists(conn: Connection, table_name: str, column_name: str) -> bool:
    """Check if a column exists in a table."""
    inspector = inspect(conn)
    columns = inspector.get_columns(table_name)
    return any(col["name"] == column_name for col in columns)


def upgrade() -> None:
    """Add role column and migrate data."""
    conn = op.get_bind()

    # 1. Add role column if it doesn't exist
    if table_exists(conn, "resource_members") and not column_exists(
        conn, "resource_members", "role"
    ):
        op.add_column(
            "resource_members",
            sa.Column(
                "role",
                sa.String(20),
                nullable=False,
                server_default="",
                comment="Member role: Owner, Maintainer, Developer, Reporter",
            ),
        )

    # 2. Migrate data from permission_level to role
    # Only run if table and columns exist
    if (
        table_exists(conn, "resource_members")
        and column_exists(conn, "resource_members", "role")
        and column_exists(conn, "resource_members", "permission_level")
    ):
        # permission_level = 'view'/'VIEW' -> role = 'Reporter'
        op.execute(
            """
            UPDATE resource_members
            SET role = 'Reporter'
            WHERE role = '' AND LOWER(permission_level) = 'view'
            """
        )

        # permission_level = 'edit'/'EDIT' -> role = 'Developer'
        op.execute(
            """
            UPDATE resource_members
            SET role = 'Developer'
            WHERE role = '' AND LOWER(permission_level) = 'edit'
            """
        )

        # permission_level = 'manage'/'MANAGE' -> role = 'Maintainer'
        # Note: Owner is not set via migration, only creator can be Owner
        op.execute(
            """
            UPDATE resource_members
            SET role = 'Maintainer'
            WHERE role = '' AND LOWER(permission_level) = 'manage'
            """
        )

    # 3. Update share_links table - add default_role column and migrate
    # First add column with empty default to allow backfill based on permission_level
    if table_exists(conn, "share_links") and not column_exists(
        conn, "share_links", "default_role"
    ):
        op.add_column(
            "share_links",
            sa.Column(
                "default_role",
                sa.String(20),
                nullable=False,
                server_default="",
                comment="Default role for joiners: Owner, Maintainer, Developer, Reporter",
            ),
        )

    # Migrate share_links default_permission_level to default_role
    # Only run if table and columns exist
    if (
        table_exists(conn, "share_links")
        and column_exists(conn, "share_links", "default_role")
        and column_exists(conn, "share_links", "default_permission_level")
    ):
        op.execute(
            """
            UPDATE share_links
            SET default_role = 'Reporter'
            WHERE default_role = ''
              AND LOWER(default_permission_level) = 'view'
            """
        )
        op.execute(
            """
            UPDATE share_links
            SET default_role = 'Developer'
            WHERE default_role = ''
              AND LOWER(default_permission_level) = 'edit'
            """
        )
        op.execute(
            """
            UPDATE share_links
            SET default_role = 'Maintainer'
            WHERE default_role = ''
              AND LOWER(default_permission_level) = 'manage'
            """
        )

    # After backfill, set the stable server_default to 'Reporter' for new rows
    # and update any remaining empty rows to 'Reporter' (fallback for unknown permission_level)
    if table_exists(conn, "share_links") and column_exists(
        conn, "share_links", "default_role"
    ):
        op.execute(
            """
            UPDATE share_links
            SET default_role = 'Reporter'
            WHERE default_role = ''
            """
        )
        op.execute(
            """
            ALTER TABLE share_links
            MODIFY COLUMN default_role VARCHAR(20) NOT NULL DEFAULT 'Reporter'
            COMMENT 'Default role for joiners: Owner, Maintainer, Developer, Reporter'
            """
        )


def downgrade() -> None:
    """Remove role column."""
    conn = op.get_bind()

    # Remove default_role column from share_links
    if table_exists(conn, "share_links") and column_exists(
        conn, "share_links", "default_role"
    ):
        op.drop_column("share_links", "default_role")

    # Remove role column from resource_members
    if table_exists(conn, "resource_members") and column_exists(
        conn, "resource_members", "role"
    ):
        op.drop_column("resource_members", "role")
