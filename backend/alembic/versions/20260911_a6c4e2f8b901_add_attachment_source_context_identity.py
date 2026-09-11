# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add attachment source context identity

Revision ID: a6c4e2f8b901
Revises: 580031eb7ddc
Create Date: 2026-09-11
"""

import sqlalchemy as sa

from alembic import op

revision = "a6c4e2f8b901"
down_revision = "580031eb7ddc"
branch_labels = None
depends_on = None


def _clear_duplicate_source_context_identities() -> None:
    """Keep one import identity without deleting legacy attachment records."""
    loop_items = sa.table(
        "loop_items",
        sa.column("id", sa.String(64)),
        sa.column("resource_type", sa.String(24)),
        sa.column("loop_item_id", sa.String(64)),
        sa.column("source_context_id", sa.BigInteger()),
        sa.column("created_at", sa.DateTime()),
    )
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(
            loop_items.c.id,
            loop_items.c.loop_item_id,
            loop_items.c.source_context_id,
        )
        .where(
            loop_items.c.resource_type == "attachment",
            loop_items.c.loop_item_id.is_not(None),
            loop_items.c.source_context_id.is_not(None),
        )
        .order_by(
            loop_items.c.loop_item_id,
            loop_items.c.source_context_id,
            loop_items.c.created_at,
            loop_items.c.id,
        )
    )

    seen: set[tuple[str, int]] = set()
    duplicate_ids: list[str] = []
    for row in rows:
        identity = (str(row.loop_item_id), int(row.source_context_id))
        if identity in seen:
            duplicate_ids.append(str(row.id))
        else:
            seen.add(identity)

    if duplicate_ids:
        connection.execute(
            loop_items.update()
            .where(loop_items.c.id == sa.bindparam("duplicate_id"))
            .values(source_context_id=None),
            [{"duplicate_id": duplicate_id} for duplicate_id in duplicate_ids],
        )


def upgrade() -> None:
    op.add_column(
        "loop_items",
        sa.Column("source_context_id", sa.BigInteger(), nullable=True),
    )
    dialect = op.get_bind().dialect.name
    if dialect == "mysql":
        op.execute(
            """
            UPDATE loop_items
            SET source_context_id = CAST(
                JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.source_context_id'))
                AS UNSIGNED
            )
            WHERE resource_type = 'attachment'
              AND JSON_EXTRACT(metadata, '$.source_context_id') IS NOT NULL
            """
        )
    elif dialect == "sqlite":
        op.execute(
            """
            UPDATE loop_items
            SET source_context_id = CAST(
                json_extract(metadata, '$.source_context_id') AS INTEGER
            )
            WHERE resource_type = 'attachment'
              AND json_extract(metadata, '$.source_context_id') IS NOT NULL
            """
        )
    else:
        op.execute(
            """
            UPDATE loop_items
            SET source_context_id = CAST(
                metadata ->> 'source_context_id' AS BIGINT
            )
            WHERE resource_type = 'attachment'
              AND metadata ->> 'source_context_id' IS NOT NULL
            """
        )
    _clear_duplicate_source_context_identities()
    if dialect == "sqlite":
        with op.batch_alter_table("loop_items") as batch_op:
            batch_op.create_unique_constraint(
                "uniq_loop_item_attachment_source_context",
                ["loop_item_id", "source_context_id"],
            )
    else:
        op.create_unique_constraint(
            "uniq_loop_item_attachment_source_context",
            "loop_items",
            ["loop_item_id", "source_context_id"],
        )


def downgrade() -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        with op.batch_alter_table("loop_items") as batch_op:
            batch_op.drop_constraint(
                "uniq_loop_item_attachment_source_context",
                type_="unique",
            )
            batch_op.drop_column("source_context_id")
    else:
        op.drop_constraint(
            "uniq_loop_item_attachment_source_context",
            "loop_items",
            type_="unique",
        )
        op.drop_column("loop_items", "source_context_id")
