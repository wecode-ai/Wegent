"""Add HTTP tool definitions to connector applications.

Revision ID: f8a9b0c1d2e3
Revises: e7f8a9b0c1d2
Create Date: 2026-07-20
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "f8a9b0c1d2e3"
down_revision: Union[str, Sequence[str], None] = "e7f8a9b0c1d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "connector_apps",
        sa.Column("http_tools", sa.JSON(), nullable=False, server_default="[]"),
    )
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("connector_apps") as batch_op:
            batch_op.alter_column("http_tools", server_default=None)
    else:
        op.alter_column("connector_apps", "http_tools", server_default=None)


def downgrade() -> None:
    op.drop_column("connector_apps", "http_tools")
