# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add_kinds_performance_indexes

Revision ID: a7b8c9d0e1f3
Revises: a0b1c2d3e4f5
Create Date: 2026-03-14

Add composite indexes to kinds table for better query performance.
These indexes optimize the /api/teams endpoint which was taking ~1s.

Performance analysis showed:
- main query (union_all): 0.699s (74%) - needs composite indexes
- batch fetch bots: 0.170s (18%) - needs composite indexes

Expected improvement: ~1s -> ~200ms
"""

import sqlalchemy as sa

from alembic import op

revision = "a7b8c9d0e1f3"
down_revision = "a0b1c2d3e4f5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add composite indexes for kinds table queries."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_indexes = {idx["name"] for idx in inspector.get_indexes("kinds")}

    # Index for user's own resources query:
    # SELECT * FROM kinds WHERE user_id=? AND kind=? AND namespace=? AND is_active=1
    if "ix_kinds_user_kind_ns_active" not in existing_indexes:
        op.create_index(
            "ix_kinds_user_kind_ns_active",
            "kinds",
            ["user_id", "kind", "namespace", "is_active"],
        )

    # Index for group resources query:
    # SELECT * FROM kinds WHERE kind=? AND namespace=? AND is_active=1
    if "ix_kinds_kind_ns_active" not in existing_indexes:
        op.create_index(
            "ix_kinds_kind_ns_active",
            "kinds",
            ["kind", "namespace", "is_active"],
        )


def downgrade() -> None:
    """Remove the composite indexes."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_indexes = {idx["name"] for idx in inspector.get_indexes("kinds")}

    if "ix_kinds_kind_ns_active" in existing_indexes:
        op.drop_index("ix_kinds_kind_ns_active", table_name="kinds")

    if "ix_kinds_user_kind_ns_active" in existing_indexes:
        op.drop_index("ix_kinds_user_kind_ns_active", table_name="kinds")
