"""merge heads

Revision ID: 5c0b248fc152
Revises: d1e2f3a4b5c6, d4e5f6a7b809
Create Date: 2026-05-14 21:16:58.240064+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "5c0b248fc152"
down_revision: Union[str, Sequence[str], None] = ("d1e2f3a4b5c6", "d4e5f6a7b809")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
