"""merge robot automation and code wiki migration heads

Revision ID: 735edcb17bec
Revises: 730e43eb7d0f, 986223386152
Create Date: 2026-08-08 01:25:34.091968+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "735edcb17bec"
down_revision: Union[str, Sequence[str], None] = ("730e43eb7d0f", "986223386152")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
