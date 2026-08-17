"""merge upstream and MR integration heads

Revision ID: 0c5cf69f98fb
Revises: e53706d9a304, f1a2b3c4d5e6
Create Date: 2026-08-17 17:03:39.271263+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0c5cf69f98fb"
down_revision: Union[str, Sequence[str], None] = ("e53706d9a304", "f1a2b3c4d5e6")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
