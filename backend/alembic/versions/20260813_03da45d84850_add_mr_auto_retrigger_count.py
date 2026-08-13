# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add mr auto retrigger count

Revision ID: 03da45d84850
Revises: 5e175aa087f2
Create Date: 2026-08-13

Tracks how many times the MR state machine auto-re-triggered a robot run on
new actionable feedback, capped by the project's ai_automation.max_retry_count.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from alembic import op

revision: str = "03da45d84850"
down_revision: Union[str, Sequence[str], None] = "5e175aa087f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _bigint() -> sa.types.TypeEngine:
    return sa.BigInteger().with_variant(sa.Integer, "sqlite")


def upgrade() -> None:
    op.add_column(
        "mr_records",
        sa.Column(
            "auto_retrigger_count",
            _bigint(),
            nullable=False,
            server_default="0",
            comment="Auto re-triggered robot runs for this MR; capped by project ai_automation",
        ),
    )


def downgrade() -> None:
    op.drop_column("mr_records", "auto_retrigger_count")
