# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""drop loop_items.local_project_id FK to projects

Revision ID: b7c9e1f3a5d2
Revises: 03da45d84850
Create Date: 2026-08-13

``loop_items.local_project_id`` stores the id of a device-local executor
workspace that the runtime resolves at dispatch time. Those ids never exist in
the backend ``projects`` table (web task groups), so the FK added by
``add_loop_items`` made "bind robot to a local project" fail with a MySQL 1452
when the target project only exists on the device. Drop the FK and keep the
column a plain integer.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "b7c9e1f3a5d2"
down_revision: Union[str, Sequence[str], None] = "03da45d84850"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint("loop_items_ibfk_5", "loop_items", type_="foreignkey")


def downgrade() -> None:
    op.create_foreign_key(
        "loop_items_ibfk_5",
        "loop_items",
        "projects",
        ["local_project_id"],
        ["id"],
        ondelete="CASCADE",
    )
