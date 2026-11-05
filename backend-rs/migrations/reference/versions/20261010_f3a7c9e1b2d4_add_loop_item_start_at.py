# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add schedulable start time to loop items.

Revision ID: f3a7c9e1b2d4
Revises: e6f1a2b3c4d5
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "f3a7c9e1b2d4"
down_revision: Union[str, None] = "e6f1a2b3c4d5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "loop_items",
        sa.Column(
            "start_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("'1970-01-01 00:00:01'"),
            comment="开始时间，纪元时间表示未设置",
        ),
    )


def downgrade() -> None:
    op.drop_column("loop_items", "start_at")
