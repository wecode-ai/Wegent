"""merge notification and transcript migration heads

Revision ID: 580031eb7ddc
Revises: b7d0e2f5a4c3, f7b8c9d0e1a2
Create Date: 2026-09-08 18:55:53.003629+08:00

"""

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = "580031eb7ddc"
down_revision: Union[str, Sequence[str], None] = ("b7d0e2f5a4c3", "f7b8c9d0e1a2")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
