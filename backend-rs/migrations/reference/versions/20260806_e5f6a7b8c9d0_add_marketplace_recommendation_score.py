# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add marketplace recommendation score

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-08-06
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, Sequence[str], None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "marketplace_resources",
        sa.Column(
            "recommendation_score",
            sa.SmallInteger(),
            nullable=False,
            server_default="0",
            comment="Marketplace recommendation score from 0 to 100",
        ),
    )
    op.create_index(
        "idx_marketplace_resources_type_recommendation",
        "marketplace_resources",
        ["resource_type", "recommendation_score", "updated_at", "kind_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_marketplace_resources_type_recommendation",
        table_name="marketplace_resources",
    )
    op.drop_column("marketplace_resources", "recommendation_score")
