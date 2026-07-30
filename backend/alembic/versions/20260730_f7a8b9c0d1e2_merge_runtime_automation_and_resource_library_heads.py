# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""merge runtime automation and resource library heads

Revision ID: f7a8b9c0d1e2
Revises: d9e4f5a6b7c8, e6f7a8b9c013
Create Date: 2026-07-30

"""

from typing import Sequence, Union

revision: str = "f7a8b9c0d1e2"
down_revision: Union[str, Sequence[str], None] = (
    "d9e4f5a6b7c8",
    "e6f7a8b9c013",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Merge Alembic heads without schema changes."""


def downgrade() -> None:
    """No-op downgrade for merge revision."""
