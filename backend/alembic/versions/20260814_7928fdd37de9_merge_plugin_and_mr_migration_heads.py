# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""merge plugin auto-update and MR fix-task migration heads

Revision ID: 7928fdd37de9
Revises: 0a3f5b7c9d1e, b7c6d5e4f3a2
Create Date: 2026-08-14

The plugin auto-update chain (f5e4d3c2b1a0 -> 8a4c1f2d9e70 -> b7c6d5e4f3a2) and
the GitLab MR fix-task chain (merged at 0a3f5b7c9d1e) diverged from
735edcb17bec in parallel; this merge only fixes the revision graph so
``alembic upgrade head`` resolves to one head. The two chains touch disjoint
tables (``kinds`` vs ``mr_*``/``loop_items``), so no data migration is needed.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "7928fdd37de9"
down_revision: Union[str, Sequence[str], None] = (
    "0a3f5b7c9d1e",
    "b7c6d5e4f3a2",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
