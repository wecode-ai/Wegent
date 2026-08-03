"""add knowledge content origin and wiki generation kb link

Revision ID: bd9c871a93d2
Revises: b9c0d1e2f3a4

Adds the two things a code wiki needs to coexist with ordinary knowledge content:

- ``origin`` on documents and folders, marking whether a row is agent-generated or
  user-owned. It defaults to ``user`` so that every existing row, and every row this
  service does not create itself, is excluded from the generated-content projection.
  Getting this backwards would let a regeneration delete content nobody can restore.
- ``kind_id`` on wiki generations, binding a version line to a knowledge base. The
  versions previously hung off ``wiki_projects``, whose ``source_url`` is globally
  unique; leaving them there would share one version line between knowledge bases
  tracking the same repository. ``0`` marks rows that predate code wikis.

All three columns are NOT NULL with a server default, as required for existing rows to
backfill without a nullable intermediate state.
"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "bd9c871a93d2"
down_revision: Union[str, Sequence[str], None] = "b9c0d1e2f3a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "knowledge_documents",
        sa.Column(
            "origin",
            sa.String(length=20),
            nullable=False,
            server_default="user",
            comment="Content ownership: 'generated' (agent-owned) or 'user'",
        ),
    )
    op.add_column(
        "knowledge_folders",
        sa.Column(
            "origin",
            sa.String(length=20),
            nullable=False,
            server_default="user",
            comment="Content ownership: 'generated' (agent-owned) or 'user'",
        ),
    )
    op.add_column(
        "wiki_generations",
        sa.Column(
            "kind_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Knowledge base this version line belongs to; 0 = legacy row",
        ),
    )
    op.create_index(
        "ix_wiki_generations_kind_id", "wiki_generations", ["kind_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_wiki_generations_kind_id", table_name="wiki_generations")
    op.drop_column("wiki_generations", "kind_id")
    op.drop_column("knowledge_folders", "origin")
    op.drop_column("knowledge_documents", "origin")
