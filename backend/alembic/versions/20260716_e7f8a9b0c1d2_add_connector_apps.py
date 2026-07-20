"""Add administrator-managed connector applications.

Revision ID: e7f8a9b0c1d2
Revises: d5e6f7a8b9c0
Create Date: 2026-07-16
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e7f8a9b0c1d2"
down_revision: Union[str, Sequence[str], None] = "d5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "connector_apps",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("slug", sa.String(length=100), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("icon_url", sa.String(length=2048), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("visibility", sa.String(length=32), nullable=False),
        sa.Column("allowed_roles", sa.JSON(), nullable=False),
        sa.Column("auth_type", sa.String(length=32), nullable=False),
        sa.Column("transport", sa.String(length=32), nullable=False),
        sa.Column("mcp_url", sa.String(length=2048), nullable=False),
        sa.Column("oauth_authorization_url", sa.String(length=2048), nullable=True),
        sa.Column("oauth_token_url", sa.String(length=2048), nullable=True),
        sa.Column("oauth_client_id", sa.String(length=512), nullable=True),
        sa.Column("oauth_client_auth_method", sa.String(length=32), nullable=False),
        sa.Column("oauth_client_secret_encrypted", sa.Text(), nullable=True),
        sa.Column("oauth_scopes", sa.JSON(), nullable=False),
        sa.Column("provider_headers_encrypted", sa.Text(), nullable=True),
        sa.Column("tool_allowlist", sa.JSON(), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
    )
    op.create_index("ix_connector_apps_enabled", "connector_apps", ["enabled"])
    op.create_index("ix_connector_apps_id", "connector_apps", ["id"])
    op.create_index("ix_connector_apps_slug", "connector_apps", ["slug"])

    op.create_table(
        "connector_connections",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("app_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("external_account_id", sa.String(length=512), nullable=True),
        sa.Column("external_account_name", sa.String(length=512), nullable=True),
        sa.Column("access_token_encrypted", sa.Text(), nullable=True),
        sa.Column("refresh_token_encrypted", sa.Text(), nullable=True),
        sa.Column("token_type", sa.String(length=64), nullable=True),
        sa.Column("granted_scopes", sa.JSON(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["app_id"], ["connector_apps.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "app_id", name="uq_connector_connection_user_app"
        ),
    )
    op.create_index(
        "ix_connector_connections_app_id", "connector_connections", ["app_id"]
    )
    op.create_index("ix_connector_connections_id", "connector_connections", ["id"])
    op.create_index(
        "ix_connector_connections_status", "connector_connections", ["status"]
    )
    op.create_index(
        "ix_connector_connections_user_id", "connector_connections", ["user_id"]
    )

    op.create_table(
        "connector_oauth_sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("state_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("app_id", sa.Integer(), nullable=False),
        sa.Column("redirect_uri", sa.String(length=2048), nullable=False),
        sa.Column("code_verifier_encrypted", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["app_id"], ["connector_apps.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("state_hash"),
    )
    op.create_index(
        "ix_connector_oauth_sessions_app_id", "connector_oauth_sessions", ["app_id"]
    )
    op.create_index(
        "ix_connector_oauth_sessions_expires_at",
        "connector_oauth_sessions",
        ["expires_at"],
    )
    op.create_index(
        "ix_connector_oauth_sessions_id", "connector_oauth_sessions", ["id"]
    )
    op.create_index(
        "ix_connector_oauth_sessions_state_hash",
        "connector_oauth_sessions",
        ["state_hash"],
    )
    op.create_index(
        "ix_connector_oauth_sessions_user_id", "connector_oauth_sessions", ["user_id"]
    )


def downgrade() -> None:
    op.drop_table("connector_oauth_sessions")
    op.drop_table("connector_connections")
    op.drop_table("connector_apps")
