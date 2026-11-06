# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""add marketplace resource owner user id

Revision ID: a8b9c0d1e2f3
Revises: f7a8b9c0d1e2
Create Date: 2026-07-31
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "a8b9c0d1e2f3"
down_revision: Union[str, Sequence[str], None] = "f7a8b9c0d1e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "marketplace_resources",
        sa.Column(
            "owner_user_id",
            sa.Integer(),
            server_default="0",
            nullable=False,
            comment="Owner user ID copied from the associated Kind resource",
        ),
    )
    op.execute(
        sa.text(
            """
            UPDATE marketplace_resources
            SET owner_user_id = (
                SELECT kinds.user_id
                FROM kinds
                WHERE kinds.id = marketplace_resources.kind_id
            )
            """
        )
    )
    op.create_index(
        "idx_marketplace_resources_owner_type_updated",
        "marketplace_resources",
        ["owner_user_id", "resource_type", "updated_at", "kind_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "idx_marketplace_resources_owner_type_updated",
        table_name="marketplace_resources",
    )
    op.drop_column("marketplace_resources", "owner_user_id")
