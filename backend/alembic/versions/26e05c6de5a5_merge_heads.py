"""merge heads

Revision ID: 26e05c6de5a5
Revises: x4y5z6a7b8c9, y5z6a7b8c9d0
Create Date: 2026-02-05 10:55:09.946735+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "26e05c6de5a5"
down_revision: Union[str, Sequence[str], None] = ("x4y5z6a7b8c9", "y5z6a7b8c9d0")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
