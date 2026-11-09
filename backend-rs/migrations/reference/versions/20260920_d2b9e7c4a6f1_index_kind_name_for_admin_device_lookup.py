# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index exact Kind names for cross-user admin device lookups.

Revision ID: d2b9e7c4a6f1
Revises: c9d4e7f1a2b3
"""

import sqlalchemy as sa

from alembic import op

revision = "d2b9e7c4a6f1"
down_revision = "c9d4e7f1a2b3"
branch_labels = None
depends_on = None

INDEX_NAME = "idx_kinds_name_kind_ns_active"


def upgrade() -> None:
    """Add the exact-name lookup index."""
    existing = {
        index["name"] for index in sa.inspect(op.get_bind()).get_indexes("kinds")
    }
    if INDEX_NAME not in existing:
        op.create_index(
            INDEX_NAME,
            "kinds",
            ["name", "kind", "namespace", "is_active"],
        )


def downgrade() -> None:
    """Remove the exact-name lookup index."""
    existing = {
        index["name"] for index in sa.inspect(op.get_bind()).get_indexes("kinds")
    }
    if INDEX_NAME in existing:
        op.drop_index(INDEX_NAME, table_name="kinds")
