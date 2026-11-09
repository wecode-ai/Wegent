"""merge heads

Revision ID: 986223386152
Revises: e5f6a7b8c9d0, a7b8c9d0e1f2
Create Date: 2026-08-06 18:33:34.324120+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "986223386152"
down_revision: Union[str, Sequence[str], None] = ("e5f6a7b8c9d0", "a7b8c9d0e1f2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
