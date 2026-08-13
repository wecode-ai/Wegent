# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""merge migration heads

Revision ID: 0a3f5b7c9d1e
Revises: b7c9e1f3a5d2, f5e4d3c2b1a0
Create Date: 2026-08-13

Merges the project-chat runtime activity key branch (f5e4d3c2b1a0) and the
loop-items local_project_id FK drop branch (b7c9e1f3a5d2) into one head so
``alembic upgrade head`` works again. The two migrations themselves are
unrelated schema changes on parallel chains from 735edcb17bec; this merge only
fixes the revision graph.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0a3f5b7c9d1e"
down_revision: Union[str, Sequence[str], None] = (
    "b7c9e1f3a5d2",
    "f5e4d3c2b1a0",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
