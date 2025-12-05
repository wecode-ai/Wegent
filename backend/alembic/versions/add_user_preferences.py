# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add preferences column to users table

Revision ID: add_user_preferences
Revises: a1b2c3d4e5f6_add_auth_source_to_users
Create Date: 2025-07-01 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "add_user_preferences"
down_revision: Union[str, None] = "a1b2c3d4e5f6_add_auth_source_to_users"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add preferences column to users table
    op.add_column(
        "users",
        sa.Column("preferences", sa.JSON(), nullable=True, default={}),
    )


def downgrade() -> None:
    # Remove preferences column from users table
    op.drop_column("users", "preferences")
