"""merge heads

Revision ID: b9fefabfa703
Revises: 3fcac954478d, f6a7b8c9d0e1
Create Date: 2025-12-10 13:02:49.456654+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b9fefabfa703'
down_revision: Union[str, Sequence[str], None] = ('3fcac954478d', 'f6a7b8c9d0e1')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
