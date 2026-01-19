# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Merge projects and summary branches

Revision ID: s9t0u1v2w3x4
Revises: q7r8s9t0u1v2, r8s9t0u1v2w3
Create Date: 2026-01-16 12:00:00.000000+08:00

This migration merges:
1. q7r8s9t0u1v2 - Add projects tables (chat groups feature)
2. r8s9t0u1v2w3 - Add summary to knowledge_documents (knowledge summary feature)
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "s9t0u1v2w3x4"
down_revision: Union[str, tuple[str, ...], None] = ("q7r8s9t0u1v2", "r8s9t0u1v2w3")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Nothing to do - this is a merge migration."""
    pass


def downgrade() -> None:
    """Nothing to do - this is a merge migration."""
    pass
