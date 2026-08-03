"""Merge marketplace and feedback migration heads.

Revision ID: c0d1e2f3a4b5
Revises: f1a2b3c4d5e6, b9c0d1e2f3a4
Create Date: 2026-08-03
"""

from typing import Sequence, Union

revision: str = "c0d1e2f3a4b5"
down_revision: Union[str, Sequence[str], None] = (
    "f1a2b3c4d5e6",
    "b9c0d1e2f3a4",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
