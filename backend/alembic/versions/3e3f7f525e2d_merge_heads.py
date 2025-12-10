"""merge heads

Revision ID: 3e3f7f525e2d
Revises: 3fcac954478d, f6a7b8c9d0e1
Create Date: 2025-12-10 13:59:26.505095+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3e3f7f525e2d"
down_revision: Union[str, Sequence[str], None] = ("3fcac954478d", "f6a7b8c9d0e1")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
