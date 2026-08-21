# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Enforce one active external event binding per logical routing key.

Revision ID: b7c8d9e0f1a2
Revises: 519f91065247
Create Date: 2026-08-21
"""

from typing import Sequence, Union

from alembic import op

revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, Sequence[str], None] = "519f91065247"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add a unique active-binding key derived from the routing columns.

    The generated column is NULL for every row except active external event
    bindings, and MySQL unique indexes ignore NULLs. Active bindings share the
    unset ``deleted_at`` sentinel, so the key enforces at most one active
    binding per (provider, opaque_ref, loop_item_id, workflow_node_id) while
    archived rows and unrelated ``loop_items`` rows stay unconstrained.
    """

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
            ) STORED,
          ADD UNIQUE INDEX uq_loop_items_active_binding_key (active_binding_key)
        """
    )


def downgrade() -> None:
    """Drop the unique active-binding key."""

    op.execute(
        "ALTER TABLE loop_items "
        "DROP INDEX uq_loop_items_active_binding_key, "
        "DROP COLUMN active_binding_key"
    )
