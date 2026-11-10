"""Revoke legacy share tokens and add token-hash storage.

Revision ID: b1c2d3e4f5a6
Revises: a4c8e2f6b901
Create Date: 2026-11-06
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "b1c2d3e4f5a6"
down_revision: Union[str, Sequence[str], None] = "f3a7c9e1b2d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "share_links",
        sa.Column(
            "token_hash",
            sa.String(length=64),
            nullable=True,
            comment="SHA-256 hash of the share token",
        ),
    )

    # MySQL fills NOT NULL columns without a default with an empty value for
    # existing rows. Backfill before tightening the constraint so multiple
    # legacy rows do not violate the unique index.
    op.execute(
        "UPDATE share_links SET token_hash = SHA2(share_token, 256) "
        "WHERE token_hash IS NULL"
    )
    op.alter_column(
        "share_links", "token_hash", existing_type=sa.String(64), nullable=False
    )

    # Legacy tokens are deterministic AES ciphertext that may have been computed
    # from public identifiers and known defaults. Revoke them and require owners
    # to issue new opaque links.
    share_links = sa.table(
        "share_links",
        sa.column("id", sa.Integer),
        sa.column("is_active", sa.Boolean),
        sa.column("updated_at", sa.DateTime),
    )
    op.execute(
        share_links.update()
        .where(share_links.c.is_active == True)  # noqa: E712
        .values(is_active=False, updated_at=sa.func.now())
    )

    op.create_unique_constraint(
        "uniq_share_links_token_hash",
        "share_links",
        ["token_hash"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uniq_share_links_token_hash",
        "share_links",
        type_="unique",
    )
    op.drop_column("share_links", "token_hash")
