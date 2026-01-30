# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add subscription follow notification config column

Revision ID: x4y5z6a7b8c9
Revises: w3x4y5z6a7b8
Create Date: 2025-01-30

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "x4y5z6a7b8c9"
down_revision: Union[str, None] = "w3x4y5z6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add config column to subscription_follows table
    # JSON structure:
    # {
    #   "notification_level": "silent" | "default" | "notify",
    #   "notification_channel_ids": [1, 2, ...]
    # }
    op.add_column(
        "subscription_follows",
        sa.Column("config", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("subscription_follows", "config")
