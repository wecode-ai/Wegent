# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""merge wework execution profiles and gitlab MR heads

Revision ID: e53706d9a304
Revises: 7928fdd37de9, c8d9e0f1a2b3
Create Date: 2026-08-17

The WeWork execution profiles chain (landed via PR #2680, rooted at
b7c6d5e4f3a2) and the GitLab MR fix-task chain (merged at 7928fdd37de9) share
the plugin chain head b7c6d5e4f3a2 as an ancestor; this merge only fixes the
revision graph so ``alembic upgrade head`` resolves to one head. The two chains
touch disjoint tables, so no data migration is needed.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "e53706d9a304"
down_revision: Union[str, Sequence[str], None] = (
    "7928fdd37de9",
    "c8d9e0f1a2b3",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
