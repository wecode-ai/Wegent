# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add enable_notification to subscription_follows

Revision ID: x4y5z6a7b8c9
Revises: w3x4y5z6a7b8
Create Date: 2025-02-01

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "x4y5z6a7b8c9"
down_revision: Union[str, None] = "w3x4y5z6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add enable_notification column to subscription_follows table
    op.add_column(
        "subscription_follows",
        sa.Column(
            "enable_notification",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )

    # Create index for querying followers with notification enabled
    op.create_index(
        "ix_sub_follow_notification",
        "subscription_follows",
        ["subscription_id", "enable_notification"],
    )


def downgrade() -> None:
    # Drop index
    op.drop_index("ix_sub_follow_notification", table_name="subscription_follows")

    # Drop column
    op.drop_column("subscription_follows", "enable_notification")
