"""merge heads

Revision ID: 56b6ed7610fe
Revises: j0k1l2m3n4o5, k1l2m3n4o5p6
Create Date: 2025-12-18 14:07:02.008419+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "56b6ed7610fe"
down_revision: Union[str, Sequence[str], None] = ("j0k1l2m3n4o5", "k1l2m3n4o5p6")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
