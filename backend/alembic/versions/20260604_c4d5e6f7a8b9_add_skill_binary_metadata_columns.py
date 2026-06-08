# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add skill binary metadata columns

Revision ID: c4d5e6f7a8b9
Revises: b2c3d4e5f6a7
Create Date: 2026-06-04

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, Sequence[str], None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add metadata columns used to distinguish skill and plugin binaries."""
    op.add_column(
        "skill_binaries",
        sa.Column("type", sa.String(length=32), nullable=False, server_default=""),
    )
    op.add_column(
        "skill_binaries",
        sa.Column(
            "file_name", sa.String(length=255), nullable=False, server_default=""
        ),
    )


def downgrade() -> None:
    """Remove skill binary metadata columns."""
    op.drop_column("skill_binaries", "file_name")
    op.drop_column("skill_binaries", "type")
