# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""use mediumblob for skill binaries

Revision ID: a2b3c4d5e6f7
Revises: 9d4be4601172
Create Date: 2026-06-01

"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision: str = "a2b3c4d5e6f7"
down_revision: Union[str, Sequence[str], None] = "9d4be4601172"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Allow public and user Skill ZIP packages up to the validator limit."""
    conn = op.get_bind()
    if conn.dialect.name != "mysql":
        return

    op.alter_column(
        "skill_binaries",
        "binary_data",
        existing_type=sa.LargeBinary(),
        type_=mysql.MEDIUMBLOB(),
        existing_nullable=False,
    )


def downgrade() -> None:
    """Restore the original MySQL BLOB column."""
    conn = op.get_bind()
    if conn.dialect.name != "mysql":
        return

    op.alter_column(
        "skill_binaries",
        "binary_data",
        existing_type=mysql.MEDIUMBLOB(),
        type_=sa.LargeBinary(),
        existing_nullable=False,
    )
