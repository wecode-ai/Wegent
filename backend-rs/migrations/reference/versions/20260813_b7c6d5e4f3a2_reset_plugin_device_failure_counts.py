# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""reset plugin device counters for consecutive-failure tracking

Revision ID: b7c6d5e4f3a2
Revises: 8a4c1f2d9e70
Create Date: 2026-08-13
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "b7c6d5e4f3a2"
down_revision: Union[str, Sequence[str], None] = "8a4c1f2d9e70"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Older releases counted every sync. Reset once before the same column starts
    # tracking consecutive failures for each device and desired release.
    op.get_bind().execute(
        sa.text("UPDATE plugin_device_installations SET attempt_count = 0")
    )


def downgrade() -> None:
    # Historical aggregate attempt counts cannot be reconstructed.
    pass
