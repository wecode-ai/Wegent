# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""extend_resource_members_for_entity

Revision ID: d1e2f3a4b5c6
Revises: a1b2c3d4e5f6
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

    # Step 5: Drop old unique constraint and create new one
    if dialect == "mysql":
        # MySQL specific: drop old FK constraint first if exists
        # Dynamically find FK constraint name from MySQL
        fk_result = conn.execute(
            sa.text(
                "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resource_members' "
                "AND CONSTRAINT_TYPE = 'FOREIGN KEY'"
            )
        ).fetchone()
        if fk_result:
            op.execute(f"ALTER TABLE resource_members DROP FOREIGN KEY {fk_result[0]}")

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


def downgrade() -> None:
    conn = op.get_bind()
    dialect = conn.dialect.name

    # Drop new unique constraint, restore old one
    if dialect == "mysql":
        # Dynamically find FK constraint name from MySQL before recreating
        fk_result = conn.execute(
            sa.text(
                "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resource_members' "
                "AND CONSTRAINT_TYPE = 'FOREIGN KEY'"
            )
        ).fetchone()
        if fk_result:
            op.execute(f"ALTER TABLE resource_members DROP FOREIGN KEY {fk_result[0]}")
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
    op.drop_column("resource_members", "entity_id")
    op.drop_column("resource_members", "entity_type")
