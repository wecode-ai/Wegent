# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""merge client origin and skill binary heads

Revision ID: b2c3d4e5f6a7
Revises: e6f7a8b9c012, a2b3c4d5e6f7
Create Date: 2026-06-02

"""

from typing import Sequence, Union

revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = (
    "e6f7a8b9c012",
    "a2b3c4d5e6f7",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Merge Alembic heads without schema changes."""


def downgrade() -> None:
    """No-op downgrade for merge revision."""
