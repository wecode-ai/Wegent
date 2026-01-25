# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add input_parameters to shared_teams

Revision ID: w3x4y5z6a7b8
Revises: v2w3x4y5z6a7
Create Date: 2025-01-26

"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "w3x4y5z6a7b8"
down_revision: Union[str, None] = "v2w3x4y5z6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add input_parameters column to shared_teams table
    op.add_column(
        "shared_teams",
        sa.Column("input_parameters", mysql.JSON(), nullable=True),
    )


def downgrade() -> None:
    # Remove input_parameters column from shared_teams table
    op.drop_column("shared_teams", "input_parameters")
