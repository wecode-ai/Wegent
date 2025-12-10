"""merge heads

Revision ID: 72d068b0f1ec
Revises: 3fcac954478d, f6a7b8c9d0e1
Create Date: 2025-12-10 14:12:04.019014+08:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '72d068b0f1ec'
down_revision: Union[str, Sequence[str], None] = ('3fcac954478d', 'f6a7b8c9d0e1')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
