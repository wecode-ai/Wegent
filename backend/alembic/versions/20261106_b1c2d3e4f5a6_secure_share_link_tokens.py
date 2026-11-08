"""Hash existing share tokens and add a unique token-hash index.

Revision ID: b1c2d3e4f5a6
Revises: a4c8e2f6b901
Create Date: 2026-11-06
"""

import hashlib
import urllib.parse
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "b1c2d3e4f5a6"
down_revision: Union[str, Sequence[str], None] = "a4c8e2f6b901"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "share_links",
        sa.Column(
            "token_hash",
            sa.String(length=64),
            nullable=False,
            server_default="",
            comment="SHA-256 hash of the share token",
        ),
    )

    share_links = sa.table(
        "share_links",
        sa.column("id", sa.Integer),
        sa.column("share_token", sa.String),
        sa.column("token_hash", sa.String),
    )
    connection = op.get_bind()
    for row in connection.execute(
        sa.select(share_links.c.id, share_links.c.share_token).where(
            share_links.c.token_hash == ""
        )
    ):
        token_hash = hashlib.sha256(
            urllib.parse.unquote(row.share_token).encode("utf-8")
        ).hexdigest()
        connection.execute(
            share_links.update()
            .where(share_links.c.id == row.id)
            .values(token_hash=token_hash)
        )

    op.create_unique_constraint(
        "uniq_share_links_token_hash",
        "share_links",
        ["token_hash"],
    )
    op.create_index(
        "idx_share_links_token_hash_active",
        "share_links",
        ["token_hash", "is_active"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "idx_share_links_token_hash_active",
        table_name="share_links",
    )
    op.drop_constraint(
        "uniq_share_links_token_hash",
        "share_links",
        type_="unique",
    )
    op.drop_column("share_links", "token_hash")
