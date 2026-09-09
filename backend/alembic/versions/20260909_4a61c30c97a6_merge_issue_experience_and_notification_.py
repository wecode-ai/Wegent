"""merge issue experience and notification heads

Revision ID: 4a61c30c97a6
Revises: 580031eb7ddc, a8c2e4f6b0d1
Create Date: 2026-09-09 15:30:50.600854+08:00

"""

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = "4a61c30c97a6"
down_revision: Union[str, Sequence[str], None] = ("580031eb7ddc", "a8c2e4f6b0d1")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Join independent migration histories without changing schema or data."""
    pass


def downgrade() -> None:
    """Restore both parent heads without changing schema or data."""
    pass
