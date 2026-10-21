"""Remove the retired branch-only account-auth policy index, if present.

Revision ID: c0e9f8d7a612
Revises: b9d8e7a6c501
Create Date: 2026-10-21
"""

import sqlalchemy as sa

from alembic import op

revision = "c0e9f8d7a612"
down_revision = "b9d8e7a6c501"
branch_labels = None
depends_on = None

INDEX_NAME = "uq_kinds_account_auth_policy"


def upgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name == "mysql":
        query = (
            "SELECT 1 FROM information_schema.statistics "
            "WHERE table_schema = DATABASE() AND table_name = 'kinds' "
            "AND index_name = :index_name LIMIT 1"
        )
    elif connection.dialect.name == "sqlite":
        query = (
            "SELECT 1 FROM sqlite_master WHERE type = 'index' "
            "AND tbl_name = 'kinds' AND name = :index_name LIMIT 1"
        )
    else:
        raise RuntimeError("Unsupported database for account-auth index cleanup")
    if connection.scalar(sa.text(query), {"index_name": INDEX_NAME}) is not None:
        op.drop_index(INDEX_NAME, table_name="kinds")


def downgrade() -> None:
    # Rolling back must not restore an index that plugin writes no longer need.
    pass
