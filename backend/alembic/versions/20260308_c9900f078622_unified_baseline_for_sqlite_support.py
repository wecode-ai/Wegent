# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unified baseline for SQLite support.

This migration serves as a baseline/milestone for both:
1. Existing MySQL users: They upgrade from a7b8c9d0e1f2 to this revision (no-op)
2. New users (MySQL or SQLite): env.py creates tables via Base.metadata.create_all()
   and stamps directly to this revision, bypassing all old MySQL-specific migrations

This approach ensures:
- Old MySQL users continue to work normally (upgrade path preserved)
- New users get cross-database compatible table creation
- Future migrations work for both MySQL and SQLite

Revision ID: c9900f078622
Revises: a7b8c9d0e1f2
Create Date: 2026-03-08

"""

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = "c9900f078622"
down_revision: Union[str, Sequence[str], None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No-op for existing users.

    For existing MySQL users upgrading from a7b8c9d0e1f2, this is a no-op
    because they already have all tables from previous migrations.

    For new users, env.py handles table creation via Base.metadata.create_all()
    and stamps directly to this revision.
    """
    pass


def downgrade() -> None:
    """No-op downgrade.

    Downgrading from this baseline is not supported for new installations
    since tables were created via metadata, not individual migrations.
    """
    pass
