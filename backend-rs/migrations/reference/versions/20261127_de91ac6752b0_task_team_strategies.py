"""Persist the accepted Pipeline definition independently of user-editable Task data."""

import sqlalchemy as sa
from alembic import op

revision = "de91ac6752b0"
down_revision = "ac7e491bf026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "task_team_strategies",
        sa.Column("task_id", sa.BigInteger(), primary_key=True, autoincrement=False),
        sa.Column("strategy", sa.JSON(), nullable=False),
        mysql_engine="InnoDB",
        if_not_exists=True,
    )


def downgrade() -> None:
    # Older releases ignore the table. Retain accepted definitions for re-upgrade.
    pass
