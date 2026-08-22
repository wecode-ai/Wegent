"""merge external event binding and smart app marketplace heads

Revision ID: 9edcca68e398
Revises: b4e7dfa1ef70, f82c5d1a9e37
Create Date: 2026-08-22 23:48:03.779939+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9edcca68e398"
down_revision: Union[str, Sequence[str], None] = ("b4e7dfa1ef70", "f82c5d1a9e37")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
