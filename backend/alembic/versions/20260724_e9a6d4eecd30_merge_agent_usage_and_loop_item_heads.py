"""merge agent usage and loop item heads

Revision ID: e9a6d4eecd30
Revises: e6f7a8b9c0d1, a6d94c3e5217
Create Date: 2026-07-24 17:46:29.474742+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e9a6d4eecd30"
down_revision: Union[str, Sequence[str], None] = ("e6f7a8b9c0d1", "a6d94c3e5217")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
