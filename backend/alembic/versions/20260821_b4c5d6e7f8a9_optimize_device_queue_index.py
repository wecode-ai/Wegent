# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Optimize the existing device queue index.

Revision ID: b4c5d6e7f8a9
Revises: e58ee381a7c2
Create Date: 2026-08-21 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op

revision: str = "b4c5d6e7f8a9"
down_revision: Union[str, None] = "e58ee381a7c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index(
        "idx_exec_device_status_order",
        table_name="loop_item_executions",
    )
    op.create_index(
        "idx_exec_device_status_order",
        "loop_item_executions",
        [
            "executor_owner_user_id",
            "execution_device_id",
            "execution_environment",
            "status",
            "priority_weight",
            "queued_at",
            "id",
        ],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "idx_exec_device_status_order",
        table_name="loop_item_executions",
    )
    op.create_index(
        "idx_exec_device_status_order",
        "loop_item_executions",
        [
            "execution_device_id",
            "status",
            "priority_weight",
            "queued_at",
        ],
        unique=False,
    )
