# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""merge knowledge artifacts and resource library heads

Revision ID: f7a8b9c0d1e2
Revises: c8d2e3f4a5b6, e6f7a8b9c013
Create Date: 2026-07-30

"""

from typing import Sequence, Union

revision: str = "f7a8b9c0d1e2"
down_revision: Union[str, Sequence[str], None] = (
    "c8d2e3f4a5b6",
    "e6f7a8b9c013",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Merge Alembic heads without schema changes."""


def downgrade() -> None:
    """No-op downgrade for merge revision."""
