# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""extend_resource_members_for_entity

Revision ID: d1e2f3a4b5c6
Revises: c3d4e5f6a708
Create Date: 2026-05-06

Add entity_type, entity_id columns to resource_members table.
Change unique constraint from (resource_type, resource_id, user_id)
to (resource_type, resource_id, entity_type, entity_id).
Keep user_id column for backward compatibility (nullable, auto-synced from entity_id
for entity_type='user' via SQLAlchemy events).
entity_id is backfilled from user_id then set to NOT NULL.
"""

import sqlalchemy as sa

from alembic import op

revision = "d1e2f3a4b5c6"
down_revision = "c3d4e5f6a708"
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
                comment="Entity type: user, namespace",
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

    # Step 3: Backfill existing rows - set entity_id = CAST(user_id AS CHAR), entity_type = 'user'
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

    # Step 3.5: Make entity_id NOT NULL after backfill
    if dialect == "mysql":
        op.alter_column(
            "resource_members",
            "entity_id",
            existing_type=sa.String(100),
            nullable=False,
        )
    elif dialect == "sqlite":
        with op.batch_alter_table("resource_members") as batch_op:
            batch_op.alter_column(
                "entity_id",
                existing_type=sa.String(100),
                nullable=False,
            )

    # Step 4: Make user_id nullable (kept for backward compatibility)
    # user_id is auto-synced from entity_id for entity_type='user' via SQLAlchemy events
    if dialect == "mysql":
        op.execute(
            "ALTER TABLE resource_members MODIFY user_id INT NULL COMMENT 'Member user ID (kept for backward compatibility, use entity_type+entity_id for new code)'"
        )
    elif dialect == "sqlite":
        with op.batch_alter_table("resource_members") as batch_op:
            batch_op.alter_column(
                "user_id",
                existing_type=sa.Integer(),
                nullable=True,
            )

    # Step 6: Add entity_display_name for entity-type member snapshots
    if "entity_display_name" not in columns:
        op.add_column(
            "resource_members",
            sa.Column(
                "entity_display_name",
                sa.String(100),
                nullable=True,
                comment="Display name snapshot for entity-type members",
            ),
        )

    # Step 5: Drop old unique constraint and create new one
    if dialect == "mysql":
        # Dynamically find the actual unique constraint/index name from MySQL
        old_uc_name_result = conn.execute(
            sa.text(
                "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resource_members' "
                "AND CONSTRAINT_TYPE = 'UNIQUE'"
            )
        ).fetchone()
        old_uc_name = (
            old_uc_name_result[0] if old_uc_name_result else "uq_resource_members"
        )

        op.drop_constraint(old_uc_name, "resource_members", type_="unique")
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

    # Step 7: Add index for entity-type queries
    op.create_index(
        "idx_resource_members_entity",
        "resource_members",
        ["entity_type", "entity_id", "resource_type", "status"],
    )


def downgrade() -> None:
    conn = op.get_bind()
    dialect = conn.dialect.name

    # Drop entity index
    op.drop_index("idx_resource_members_entity", table_name="resource_members")

    # Drop new unique constraint, restore old one
    if dialect == "mysql":
        # Dynamically find the current unique constraint name
        new_uc_name_result = conn.execute(
            sa.text(
                "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resource_members' "
                "AND CONSTRAINT_TYPE = 'UNIQUE'"
            )
        ).fetchone()
        new_uc_name = (
            new_uc_name_result[0]
            if new_uc_name_result
            else "uq_resource_members_entity"
        )

        op.drop_constraint(new_uc_name, "resource_members", type_="unique")
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

    # Drop added columns (check existence to tolerate partial rollback states)
    inspector = sa.inspect(conn)
    columns = [col["name"] for col in inspector.get_columns("resource_members")]
    if "entity_display_name" in columns:
        op.drop_column("resource_members", "entity_display_name")
    if "entity_id" in columns:
        op.drop_column("resource_members", "entity_id")
    if "entity_type" in columns:
        op.drop_column("resource_members", "entity_type")
