"""Add persistent OAuth refresh tokens.

Revision ID: 8d3d51c83c99
Revises: d6e7f8a9b0c1
Create Date: 2026-08-31 00:00:00+08:00
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "8d3d51c83c99"
down_revision: Union[str, Sequence[str], None] = "d6e7f8a9b0c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "oauth_refresh_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("token_prefix", sa.String(length=16), nullable=False),
        sa.Column("family_id", sa.String(length=36), nullable=False),
        sa.Column("client_kind_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("replaced_by_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_oauth_refresh_tokens_token_hash",
        "oauth_refresh_tokens",
        ["token_hash"],
        unique=True,
    )
    op.create_index(
        "ix_oauth_refresh_tokens_family_id",
        "oauth_refresh_tokens",
        ["family_id"],
    )
    op.create_index(
        "ix_oauth_refresh_tokens_client_kind_id",
        "oauth_refresh_tokens",
        ["client_kind_id"],
    )
    op.create_index(
        "ix_oauth_refresh_tokens_user_id",
        "oauth_refresh_tokens",
        ["user_id"],
    )
    op.create_index(
        "ix_oauth_refresh_tokens_expires_at",
        "oauth_refresh_tokens",
        ["expires_at"],
    )
    op.create_index(
        "ix_oauth_refresh_tokens_revoked_at",
        "oauth_refresh_tokens",
        ["revoked_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_oauth_refresh_tokens_revoked_at",
        table_name="oauth_refresh_tokens",
    )
    op.drop_index(
        "ix_oauth_refresh_tokens_expires_at",
        table_name="oauth_refresh_tokens",
    )
    op.drop_index(
        "ix_oauth_refresh_tokens_user_id",
        table_name="oauth_refresh_tokens",
    )
    op.drop_index(
        "ix_oauth_refresh_tokens_client_kind_id",
        table_name="oauth_refresh_tokens",
    )
    op.drop_index(
        "ix_oauth_refresh_tokens_family_id",
        table_name="oauth_refresh_tokens",
    )
    op.drop_index(
        "ix_oauth_refresh_tokens_token_hash",
        table_name="oauth_refresh_tokens",
    )
    op.drop_table("oauth_refresh_tokens")
