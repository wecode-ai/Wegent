"""rename source_provider wegent to wework

Revision ID: f7a8b9c0d1e3
Revises: e6f7a8b9c0d1
Create Date: 2026-07-27 18:10:00.000000

"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "f7a8b9c0d1e3"
down_revision = "e6f7a8b9c0d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Update existing plugins with source_provider='wegent' to 'wework'
    op.execute(
        "UPDATE plugins SET source_provider = 'wework' WHERE source_provider = 'wegent'"
    )


def downgrade() -> None:
    # Revert wework back to wegent
    op.execute(
        "UPDATE plugins SET source_provider = 'wegent' WHERE source_provider = 'wework'"
    )
