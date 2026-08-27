# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persist the source extension for DingTalk document import classification."""

import sqlalchemy as sa

from alembic import op

revision = "d6e7f8a9b0c1"
down_revision = "c5d6e7f8a9b0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dingtalk_synced_nodes",
        sa.Column("extension", sa.String(32), nullable=False, server_default=""),
    )
    op.execute(
        sa.text(
            "UPDATE dingtalk_synced_nodes SET extension = 'adoc' WHERE node_type = 'doc'"
        )
    )


def downgrade() -> None:
    op.drop_column("dingtalk_synced_nodes", "extension")
