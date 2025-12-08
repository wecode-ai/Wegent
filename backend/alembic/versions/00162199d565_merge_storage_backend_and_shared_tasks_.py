"""merge storage backend and shared tasks migrations

Revision ID: 00162199d565
Revises: 2b3c4d5e6f7g, add_storage_backend_columns
Create Date: 2025-12-08 10:49:03.869486+08:00

"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "00162199d565"
down_revision: Union[str, Sequence[str], None] = (
    "2b3c4d5e6f7g",
    "add_storage_backend_columns",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
