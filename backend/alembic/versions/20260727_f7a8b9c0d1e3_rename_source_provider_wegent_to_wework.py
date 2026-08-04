"""rename source_provider wegent to wework

Revision ID: f7a8b9c0d1e3
Revises: e6f7a8b9c0d1
Create Date: 2026-07-27 18:10:00.000000

"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "f7a8b9c0d1e3"
down_revision = "e6f7a8b9c0d1"
branch_labels = None
depends_on = None

TRACKING_TABLE = "migration_f7a8b9c0d1e3_plugins"


def upgrade() -> None:
    op.create_table(
        TRACKING_TABLE,
        sa.Column("plugin_id", sa.BigInteger(), primary_key=True),
    )
    op.execute(
        f"""
        INSERT INTO {TRACKING_TABLE} (plugin_id)
        SELECT id FROM plugins WHERE source_provider = 'wegent'
        """
    )
    op.execute(
        f"""
        UPDATE plugins
        SET source_provider = 'wework'
        WHERE id IN (SELECT plugin_id FROM {TRACKING_TABLE})
          AND source_provider = 'wegent'
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        UPDATE plugins
        SET source_provider = 'wegent'
        WHERE id IN (SELECT plugin_id FROM {TRACKING_TABLE})
          AND source_provider = 'wework'
        """
    )
    op.drop_table(TRACKING_TABLE)
