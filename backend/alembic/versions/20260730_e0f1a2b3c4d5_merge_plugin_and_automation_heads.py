"""Merge plugin and automation migration heads.

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4, d9e4f5a6b7c8
Create Date: 2026-07-30
"""

from typing import Sequence, Union

revision: str = "e0f1a2b3c4d5"
down_revision: Union[str, Sequence[str], None] = (
    "d9e0f1a2b3c4",
    "d9e4f5a6b7c8",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
