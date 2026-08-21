# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Add external event binding routing columns and one active binding per key.

Squashes the previously parallel ``add_external_event_binding_columns`` and
``enforce_unique_active_external_bindings`` migrations (joined by a no-op merge)
into a single migration on top of ``d47dd270f4b6``.

Revision ID: b4e7dfa1ef70
Revises: d47dd270f4b6
Create Date: 2026-08-21
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "b4e7dfa1ef70"
down_revision: Union[str, Sequence[str], None] = "d47dd270f4b6"
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

    # The generated column is NULL for every row except active external event
    # bindings, and MySQL unique indexes ignore NULLs. Active bindings share the
    # unset ``deleted_at`` sentinel, so the key enforces at most one active
    # binding per (provider, opaque_ref, loop_item_id, workflow_node_id) while
    # archived rows and unrelated ``loop_items`` rows stay unconstrained.
    #
    # The column must be VIRTUAL: InnoDB rejects a STORED generated column that
    # references a column used in a foreign key (error 1215), and loop_item_id
    # is the base of such a constraint.
    op.execute(
        """
        ALTER TABLE loop_items
          ADD COLUMN active_binding_key VARCHAR(712)
            GENERATED ALWAYS AS (
              CASE
                WHEN (deleted_at IS NULL
                      OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))
                  AND provider IS NOT NULL
                  AND opaque_ref IS NOT NULL
                  AND loop_item_id IS NOT NULL
                THEN CONCAT_WS(
                  '\\0',
                  provider,
                  opaque_ref,
                  loop_item_id,
                  JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.workflow_node_id'))
                )
                ELSE NULL
              END
            ) VIRTUAL,
          ADD UNIQUE INDEX uq_loop_items_active_binding_key (active_binding_key)
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE loop_items "
        "DROP INDEX uq_loop_items_active_binding_key, "
        "DROP COLUMN active_binding_key"
    )
    op.drop_index("idx_loop_items_provider_ref", table_name="loop_items")
    op.drop_column("loop_items", "opaque_ref")
    op.drop_column("loop_items", "provider")
