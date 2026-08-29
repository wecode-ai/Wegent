# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cache the original MCP directory node metadata."""

import sqlalchemy as sa

from alembic import op

revision = "d6e7f8a9b0c1"
down_revision = "c5d6e7f8a9b0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dingtalk_synced_nodes",
        sa.Column("raw_metadata", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dingtalk_synced_nodes", "raw_metadata")
