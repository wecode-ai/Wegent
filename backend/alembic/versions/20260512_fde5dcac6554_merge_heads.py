"""merge heads

Revision ID: fde5dcac6554
Revises: b2c3d4e5f707, d1e2f3a4b5c6
Create Date: 2026-05-12 05:09:00.735064+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fde5dcac6554'
down_revision: Union[str, Sequence[str], None] = ('b2c3d4e5f707', 'd1e2f3a4b5c6')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
