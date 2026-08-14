# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Merge the project-chat and plugin-auto-update migration branches.

Revision ID: d9e0f1a2b3c4
Revises: b7c6d5e4f3a2, f5e4d3c2b1a0
Create Date: 2026-08-13
"""

from typing import Sequence, Union

revision: str = "d9e0f1a2b3c4"
down_revision: Union[str, Sequence[str], None] = (
    "b7c6d5e4f3a2",
    "f5e4d3c2b1a0",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
