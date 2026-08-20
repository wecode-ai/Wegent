"""merge external event binding and knowledge retrieval profile heads

Revision ID: 519f91065247
Revises: a4b5c6d7e8f9, d47dd270f4b6
Create Date: 2026-08-20 23:20:51.958659+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "519f91065247"
down_revision: Union[str, Sequence[str], None] = ("a4b5c6d7e8f9", "d47dd270f4b6")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
