# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Merge task metric and plugin marketplace migration heads.

Revision ID: f1a2b3c4d5e6
Revises: e1f2a3b4c5d6, d4e5f6a7b8c9
Create Date: 2026-08-06
"""

from typing import Sequence, Union

revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = (
    "e1f2a3b4c5d6",
    "d4e5f6a7b8c9",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
