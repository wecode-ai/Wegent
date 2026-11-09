"""Revoke legacy share tokens and add token-hash storage.

Revision ID: b1c2d3e4f5a6
Revises: a4c8e2f6b901
Create Date: 2026-11-06
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "b1c2d3e4f5a6"
down_revision: Union[str, Sequence[str], None] = "a4c8e2f6b901"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Keep the column non-nullable with no default so older application
    # instances fail inserts instead of writing unusable empty hashes during a
    # rolling deploy.
    op.add_column(
        "share_links",
        sa.Column(
            "token_hash",
            sa.String(length=64),
            nullable=False,
            comment="SHA-256 hash of the share token",
        ),
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
    op.create_index(
        "idx_share_links_token_hash_active",
        "share_links",
        ["token_hash", "is_active"],
        unique=False,
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
