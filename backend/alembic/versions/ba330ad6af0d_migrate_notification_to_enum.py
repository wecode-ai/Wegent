# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Migrate notification from boolean to enum

Revision ID: ba330ad6af0d
Revises: x4y5z6a7b8c9
Create Date: 2025-02-03

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "ba330ad6af0d"
down_revision: Union[str, None] = "x4y5z6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Check if column already exists (migration partially run before)
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [col["name"] for col in inspector.get_columns("subscription_follows")]

    # 1. Add new column with nullable=True temporarily (if not exists)
    if "notification_preference" not in columns:
        op.add_column(
            "subscription_follows",
            sa.Column(
                "notification_preference",
                sa.String(20),
                nullable=True,
            ),
        )

    # 2. Migrate data: true -> 'default', false -> 'silent'
    op.execute(
        """
        UPDATE subscription_follows
        SET notification_preference = CASE
            WHEN enable_notification = 1 THEN 'default'
            ELSE 'silent'
        END
    """
    )

    # 3. Make new column non-nullable
    op.alter_column(
        "subscription_follows",
        "notification_preference",
        existing_type=sa.String(20),
        nullable=False,
        server_default=sa.text("'default'"),
    )

    # 4. Drop old index
    op.drop_index("ix_sub_follow_notification", table_name="subscription_follows")

    # 5. Create new index
    op.create_index(
        "ix_sub_follow_notification",
        "subscription_follows",
        ["subscription_id", "notification_preference"],
    )

    # 6. Drop old column
    op.drop_column("subscription_follows", "enable_notification")


def downgrade() -> None:
    # 1. Add old column back
    op.add_column(
        "subscription_follows",
        sa.Column(
            "enable_notification",
            sa.Boolean(),
            nullable=True,
            server_default=sa.true(),
        ),
    )

    # 2. Migrate data back: 'silent' -> false, others -> true
    op.execute(
        """
        UPDATE subscription_follows
        SET enable_notification = CASE
            WHEN notification_preference = 'silent' THEN 0
            ELSE 1
        END
    """
    )

    # 3. Make old column non-nullable
    op.alter_column(
        "subscription_follows",
        "enable_notification",
        existing_type=sa.Boolean(),
        nullable=False,
    )

    # 4. Drop new index
    op.drop_index("ix_sub_follow_notification", table_name="subscription_follows")

    # 5. Create old index
    op.create_index(
        "ix_sub_follow_notification",
        "subscription_follows",
        ["subscription_id", "enable_notification"],
    )

    # 6. Drop new column
    op.drop_column("subscription_follows", "notification_preference")
