# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add config json to projects

Revision ID: d4e5f6a7b809
Revises: c3d4e5f6a708
Create Date: 2026-05-13
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "d4e5f6a7b809"
down_revision = "d1e2f3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add config JSON column to projects table."""
    op.add_column(
        "projects",
        sa.Column(
            "config",
            sa.JSON(),
            nullable=True,
            comment="Workspace project configuration. Empty means legacy task group.",
        ),
    )


def downgrade() -> None:
    """Remove config column from projects table."""
    op.drop_column("projects", "config")
