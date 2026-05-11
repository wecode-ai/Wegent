# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""extend_resource_members_for_entity

Revision ID: d1e2f3a4b5c6
Revises: a1b2c3d4e5f6
Create Date: 2026-05-06

Add entity_type, entity_id, entity_name columns to resource_members table.
Change unique constraint from (resource_type, resource_id, user_id)
to (resource_type, resource_id, entity_type, entity_id).
Make user_id nullable to support non-user entity types.
"""

import sqlalchemy as sa

from alembic import op

revision = "d1e2f3a4b5c6"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [col["name"] for col in inspector.get_columns("resource_members")]

    # Step 1: Add entity_type column
    if "entity_type" not in columns:
        op.add_column(
            "resource_members",
            sa.Column(
                "entity_type",
                sa.String(20),
                nullable=False,
                server_default="user",
                comment="Entity type: user, org_department",
            ),
        )

    # Step 2: Add entity_id column
    if "entity_id" not in columns:
        op.add_column(
            "resource_members",
            sa.Column(
                "entity_id",
                sa.String(100),
                nullable=True,
                comment="Entity identifier: user_id for 'user', external ID for others",
            ),
        )

    # Step 3: Add entity_name column
    if "entity_name" not in columns:
        op.add_column(
            "resource_members",
            sa.Column(
                "entity_name",
                sa.String(255),
                nullable=True,
                comment="Entity display name (for non-user entities)",
            ),
        )

    # Step 4: Backfill existing rows - set entity_id = CAST(user_id AS CHAR), entity_type = 'user'
    dialect = conn.dialect.name
    if dialect == "mysql":
        op.execute(
            """
            UPDATE resource_members
            SET entity_id = CAST(user_id AS CHAR), entity_type = 'user'
            WHERE entity_id IS NULL
        """
        )
    elif dialect == "sqlite":
        op.execute(
            """
            UPDATE resource_members
            SET entity_id = CAST(user_id AS TEXT), entity_type = 'user'
            WHERE entity_id IS NULL
        """
        )

    # Step 5: Make user_id nullable
    if dialect == "mysql":
        op.execute(
            "ALTER TABLE resource_members MODIFY user_id INT NULL COMMENT 'Member user ID (nullable for non-user entity types)'"
        )

    # Step 6: Drop old unique constraint and create new one
    if dialect == "mysql":
        # MySQL specific: drop old FK constraint first if exists
        op.execute(
            "ALTER TABLE resource_members DROP FOREIGN KEY IF EXISTS resource_members_ibfk_1"
        )
        op.drop_constraint("uq_resource_members", "resource_members", type_="unique")
        op.create_unique_constraint(
            "uq_resource_members_entity",
            "resource_members",
            ["resource_type", "resource_id", "entity_type", "entity_id"],
        )
    else:
        # SQLite: use batch operations
        with op.batch_alter_table("resource_members") as batch_op:
            batch_op.drop_constraint("uq_resource_members", type_="unique")
            batch_op.create_unique_constraint(
                "uq_resource_members_entity",
                ["resource_type", "resource_id", "entity_type", "entity_id"],
            )


def downgrade() -> None:
    conn = op.get_bind()
    dialect = conn.dialect.name

    # Drop new unique constraint, restore old one
    if dialect == "mysql":
        op.drop_constraint(
            "uq_resource_members_entity", "resource_members", type_="unique"
        )
        op.create_unique_constraint(
            "uq_resource_members",
            "resource_members",
            ["resource_type", "resource_id", "user_id"],
        )
    else:
        with op.batch_alter_table("resource_members") as batch_op:
            batch_op.drop_constraint("uq_resource_members_entity", type_="unique")
            batch_op.create_unique_constraint(
                "uq_resource_members",
                ["resource_type", "resource_id", "user_id"],
            )

    # Drop added columns
    op.drop_column("resource_members", "entity_name")
    op.drop_column("resource_members", "entity_id")
    op.drop_column("resource_members", "entity_type")
