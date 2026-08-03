"""Merge plugin marketplace and loop item migration heads.

Revision ID: c8d9e0f1a2b3
Revises: b7c1d2e3f4a5, f7a8b9c0d1e3
Create Date: 2026-07-27
"""

from typing import Sequence, Union

revision: str = "c8d9e0f1a2b3"
down_revision: Union[str, Sequence[str], None] = (
    "b7c1d2e3f4a5",
    "f7a8b9c0d1e3",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
