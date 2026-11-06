"""Add persistent OAuth refresh tokens.

Schema follows production DB audit rules: every column has COMMENT, non-PK
columns are NOT NULL with explicit DEFAULT, no foreign keys, unique indexes use
the uniq_ prefix, ordinary indexes use the idx_ prefix, and optional values use
0 / 1970-01-01 00:00:00 sentinels.

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

_UNSET_TIME = "1970-01-01 00:00:00"


def upgrade() -> None:
    op.create_table(
        "oauth_refresh_tokens",
        sa.Column(
            "id",
            sa.Integer(),
            autoincrement=True,
            nullable=False,
            comment="Primary key",
        ),
        sa.Column(
            "token_hash",
            sa.String(length=64),
            nullable=False,
            server_default="",
            comment="SHA-256 hash of the refresh token",
        ),
        sa.Column(
            "token_prefix",
            sa.String(length=16),
            nullable=False,
            server_default="",
            comment="Non-secret token prefix for diagnostics",
        ),
        sa.Column(
            "family_id",
            sa.String(length=36),
            nullable=False,
            server_default="",
            comment="Refresh-token rotation family UUID",
        ),
        sa.Column(
            "client_kind_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="OAuth client kinds.id; 0 means unset",
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Authorizing users.id; 0 means unset",
        ),
        sa.Column(
            "expires_at",
            sa.DateTime(),
            nullable=False,
            server_default=_UNSET_TIME,
            comment="Expiration time",
        ),
        sa.Column(
            "used_at",
            sa.DateTime(),
            nullable=False,
            server_default=_UNSET_TIME,
            comment="Rotation time; epoch means unused",
        ),
        sa.Column(
            "revoked_at",
            sa.DateTime(),
            nullable=False,
            server_default=_UNSET_TIME,
            comment="Revocation time; epoch means active",
        ),
        sa.Column(
            "replaced_by_id",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="Replacement token row id; 0 means unset",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
            comment="Creation time",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "token_hash",
            name="uniq_oauth_refresh_tokens_token_hash",
        ),
        comment="OAuth refresh-token rotation and revocation records",
        mysql_charset="utf8mb4",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "idx_oauth_refresh_tokens_family_id",
        "oauth_refresh_tokens",
        ["family_id"],
    )
    op.create_index(
        "idx_oauth_refresh_tokens_client_kind_id",
        "oauth_refresh_tokens",
        ["client_kind_id"],
    )
    op.create_index(
        "idx_oauth_refresh_tokens_user_id",
        "oauth_refresh_tokens",
        ["user_id"],
    )
    op.create_index(
        "idx_oauth_refresh_tokens_expires_at",
        "oauth_refresh_tokens",
        ["expires_at"],
    )
    op.create_index(
        "idx_oauth_refresh_tokens_revoked_at",
        "oauth_refresh_tokens",
        ["revoked_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_oauth_refresh_tokens_revoked_at",
        table_name="oauth_refresh_tokens",
    )
    op.drop_index(
        "idx_oauth_refresh_tokens_expires_at",
        table_name="oauth_refresh_tokens",
    )
    op.drop_index(
        "idx_oauth_refresh_tokens_user_id",
        table_name="oauth_refresh_tokens",
    )
    op.drop_index(
        "idx_oauth_refresh_tokens_client_kind_id",
        table_name="oauth_refresh_tokens",
    )
    op.drop_index(
        "idx_oauth_refresh_tokens_family_id",
        table_name="oauth_refresh_tokens",
    )
    op.drop_table("oauth_refresh_tokens")
