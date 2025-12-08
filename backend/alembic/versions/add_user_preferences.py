# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add preferences column to users table

Revision ID: add_user_preferences
Revises: 2b3c4d5e6f7g
Create Date: 2025-12-05 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "add_user_preferences"
down_revision: Union[str, None] = "00162199d565"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add preferences column to users table
    op.add_column(
        "users",
        sa.Column(
            "preferences",
            sa.String(4096),
            nullable=False,
            server_default="{}",
            comment="user preferences",
        ),
    )


def downgrade() -> None:
    # Remove preferences column from users table
    op.drop_column("users", "preferences")
