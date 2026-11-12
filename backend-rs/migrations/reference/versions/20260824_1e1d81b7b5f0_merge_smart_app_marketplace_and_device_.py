"""merge smart app marketplace and device queue heads

Revision ID: 1e1d81b7b5f0
Revises: f82c5d1a9e37, b4c5d6e7f8a9
Create Date: 2026-08-24 10:32:23.747079+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "1e1d81b7b5f0"
down_revision: Union[str, Sequence[str], None] = ("f82c5d1a9e37", "b4c5d6e7f8a9")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
