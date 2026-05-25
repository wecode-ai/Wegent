"""add_resource_members_entity_lookup_index

Revision ID: 9d4be4601172
Revises: d4e5f6a7b810
Create Date: 2026-05-19 12:52:55.172810+08:00

Add idx_resource_members_entity_lookup index for efficient entity-type
resource membership queries. Replaces the older idx_resource_members_entity
index with a more optimal column ordering.

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision = "9d4be4601172"
down_revision = "d4e5f6a7b810"
branch_labels = None
depends_on = None


def _index_exists(table_name: str, index_name: str) -> bool:
    """Check if an index exists on the given table."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    indexes = [idx["name"] for idx in inspector.get_indexes(table_name)]
    return index_name in indexes


def upgrade() -> None:
    """Upgrade schema."""
    # Drop the old index if it exists (replaced by the new one)
    if _index_exists("resource_members", "idx_resource_members_entity"):
        op.drop_index("idx_resource_members_entity", table_name="resource_members")

    # Create the new optimized index if it doesn't exist
    if not _index_exists("resource_members", "idx_resource_members_entity_lookup"):
        op.create_index(
            "idx_resource_members_entity_lookup",
            "resource_members",
            ["entity_type", "entity_id", "status", "resource_type"],
            unique=False,
        )


def downgrade() -> None:
    """Downgrade schema."""
    if _index_exists("resource_members", "idx_resource_members_entity_lookup"):
        op.drop_index(
            "idx_resource_members_entity_lookup", table_name="resource_members"
        )

    if not _index_exists("resource_members", "idx_resource_members_entity"):
        op.create_index(
            "idx_resource_members_entity",
            "resource_members",
            ["entity_type", "entity_id", "resource_type", "status"],
            unique=False,
        )
