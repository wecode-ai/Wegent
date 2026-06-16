# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""extend_resource_members_for_entity

Revision ID: d1e2f3a4b5c6
Revises: c3d4e5f6a708
Create Date: 2026-05-06

Add entity_type, entity_id, entity_display_name columns to resource_members table.
Drop old unique constraint (resource_type, resource_id, user_id) and create new
unique constraint (resource_type, resource_id, entity_type, entity_id).
Keep user_id column for backward compatibility (NOT NULL DEFAULT 0, auto-synced
from entity_id for entity_type='user' via SQLAlchemy events).
entity_id is backfilled from user_id for existing rows.
"""

import sqlalchemy as sa

from alembic import op

revision = "d1e2f3a4b5c6"
down_revision = "c3d4e5f6a708"
branch_labels = None
depends_on = None

OLD_UNIQUE_COLUMNS = ["resource_type", "resource_id", "user_id"]
NEW_UNIQUE_COLUMNS = ["resource_type", "resource_id", "entity_type", "entity_id"]


def _index_exists(table_name: str, index_name: str) -> bool:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    indexes = [idx["name"] for idx in inspector.get_indexes(table_name)]
    return index_name in indexes


def _unique_constraint_name_for_columns(
    table_name: str, column_names: list[str]
) -> str | None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    for constraint in inspector.get_unique_constraints(table_name):
        if constraint.get("column_names") == column_names:
            return constraint.get("name")
    return None


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

    # Step 2: Add entity_id column (NOT NULL with empty default, backfilled immediately)
    if "entity_id" not in columns:
        op.add_column(
            "resource_members",
            sa.Column(
                "entity_id",
                sa.String(100),
                nullable=False,
                server_default="",
                comment="Entity identifier: user_id for 'user', external ID for others",
            ),
        )

    # Step 3: Backfill existing rows
    # All existing rows have valid user_id (>0), no fallback needed.
    dialect = conn.dialect.name
    if dialect == "mysql":
        op.execute(
            """
            UPDATE resource_members
            SET entity_id = CAST(user_id AS CHAR), entity_type = 'user'
            """
        )
    elif dialect == "sqlite":
        op.execute(
            """
            UPDATE resource_members
            SET entity_id = CAST(user_id AS TEXT), entity_type = 'user'
            """
        )

    # Step 4: Add entity_display_name column
    if "entity_display_name" not in columns:
        op.add_column(
            "resource_members",
            sa.Column(
                "entity_display_name",
                sa.String(100),
                nullable=False,
                server_default="",
                comment="Display name snapshot for entity-type members",
            ),
        )

    # Step 5: Drop old unique constraint and create new one
    old_uc_name = _unique_constraint_name_for_columns(
        "resource_members", OLD_UNIQUE_COLUMNS
    )
    new_uc_name = _unique_constraint_name_for_columns(
        "resource_members", NEW_UNIQUE_COLUMNS
    )

    if dialect == "mysql":
        if old_uc_name:
            op.drop_constraint(old_uc_name, "resource_members", type_="unique")
        if not new_uc_name:
            op.create_unique_constraint(
                "uniq_resource_members_entity",
                "resource_members",
                NEW_UNIQUE_COLUMNS,
            )
    else:
        # SQLite: use batch operations
        if old_uc_name or not new_uc_name:
            with op.batch_alter_table("resource_members") as batch_op:
                if old_uc_name:
                    batch_op.drop_constraint(old_uc_name, type_="unique")
                if not new_uc_name:
                    batch_op.create_unique_constraint(
                        "uniq_resource_members_entity",
                        NEW_UNIQUE_COLUMNS,
                    )

    # Step 6: Add index for entity-type queries
    if not _index_exists("resource_members", "idx_resource_members_entity"):
        op.create_index(
            "idx_resource_members_entity",
            "resource_members",
            ["entity_type", "entity_id", "resource_type", "status"],
        )


def downgrade() -> None:
    conn = op.get_bind()
    dialect = conn.dialect.name

    # Drop entity index
    if _index_exists("resource_members", "idx_resource_members_entity"):
        op.drop_index("idx_resource_members_entity", table_name="resource_members")

    # Drop new unique constraint, restore old one
    old_uc_name = _unique_constraint_name_for_columns(
        "resource_members", OLD_UNIQUE_COLUMNS
    )
    new_uc_name = _unique_constraint_name_for_columns(
        "resource_members", NEW_UNIQUE_COLUMNS
    )

    if dialect == "mysql":
        if new_uc_name:
            op.drop_constraint(new_uc_name, "resource_members", type_="unique")
        if not old_uc_name:
            op.create_unique_constraint(
                "uniq_resource_members",
                "resource_members",
                OLD_UNIQUE_COLUMNS,
            )
    else:
        if new_uc_name or not old_uc_name:
            with op.batch_alter_table("resource_members") as batch_op:
                if new_uc_name:
                    batch_op.drop_constraint(new_uc_name, type_="unique")
                if not old_uc_name:
                    batch_op.create_unique_constraint(
                        "uniq_resource_members",
                        OLD_UNIQUE_COLUMNS,
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
