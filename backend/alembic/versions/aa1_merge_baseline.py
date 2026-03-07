# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Merge baseline with old migration chain

Revision ID: aa1_merge_baseline
Revises: z6a7b8c9d0e1, aa0_unified_schema_init
Create Date: 2025-03-07

This is a merge migration that connects two migration chains:

1. Old chain (MySQL-specific): 0c086b93f8b9 -> ... -> z6a7b8c9d0e1
   - Used by existing MySQL users who are upgrading
   - Contains MySQL-specific SQL that doesn't work on SQLite

2. New baseline: aa0_unified_schema_init
   - Used by new users (both MySQL and SQLite)
   - Uses SQLAlchemy's Base.metadata.create_all() for cross-database compatibility

Migration paths:
- New users: aa0_unified_schema_init -> aa1_merge_baseline -> future migrations
- Old users: ... -> z6a7b8c9d0e1 -> aa1_merge_baseline -> future migrations

This merge point ensures both old and new users converge to the same state,
allowing future migrations to work for everyone.

Note: This migration does nothing - it's just a merge point.
All schema changes have already been applied by either:
- The old migration chain (for existing users)
- The new baseline (for new users)
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "aa1_merge_baseline"
# This is a merge migration - it has two parents
down_revision: Union[str, Sequence[str], None] = (
    "a7b8c9d0e1f2",  # Old MySQL migration chain head
    "aa0_unified_schema_init",  # New unified baseline
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    Merge point - no schema changes needed.

    Both migration paths (old chain and new baseline) result in the same
    schema state, so this migration is just a merge point.
    """
    pass


def downgrade() -> None:
    """
    Merge point - no schema changes needed.

    Downgrading from this point will follow one of the parent branches
    depending on which path was taken during upgrade.
    """
    pass
