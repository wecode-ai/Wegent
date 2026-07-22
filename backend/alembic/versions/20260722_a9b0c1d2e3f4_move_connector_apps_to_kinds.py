"""Move connector applications to kinds.

Revision ID: a9b0c1d2e3f4
Revises: f8a9b0c1d2e3
Create Date: 2026-07-22
"""

import logging
from typing import Any, Sequence, Union

import sqlalchemy as sa

from alembic import op
from shared.utils.crypto import (
    decrypt_sensitive_data_with_embedded_iv,
    encrypt_sensitive_data,
)

revision: str = "a9b0c1d2e3f4"
down_revision: Union[str, Sequence[str], None] = "f8a9b0c1d2e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None
logger = logging.getLogger(__name__)

CONNECTOR_APP_KIND = "ConnectorApp"
CONNECTOR_APP_NAMESPACE = "system"
CONNECTOR_APP_USER_ID = 0


class EmbeddedIvReencryptError(ValueError):
    """Raised when migration cannot re-encrypt an embedded-IV ciphertext."""


def _table_exists(table_name: str) -> bool:
    return table_name in sa.inspect(op.get_bind()).get_table_names()


def _json_value(value: Any, default: Any) -> Any:
    return default if value is None else value


def _reencrypt_embedded_iv(value: str | None, *, context: str) -> str | None:
    if not value:
        return None
    try:
        decrypted = decrypt_sensitive_data_with_embedded_iv(value)
    except Exception as exc:
        logger.exception(
            "Failed to decrypt embedded-IV connector app value during migration; "
            "context=%s value=%r",
            context,
            value,
        )
        raise EmbeddedIvReencryptError(
            f"Cannot migrate encrypted connector app value: {context}"
        ) from exc
    return encrypt_sensitive_data(decrypted or "") if decrypted else None


def _connector_payload(row: sa.RowMapping) -> dict[str, Any]:
    slug = row["slug"]
    name = row["name"]
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": CONNECTOR_APP_KIND,
        "metadata": {
            "name": slug,
            "namespace": CONNECTOR_APP_NAMESPACE,
            "displayName": name,
        },
        "spec": {
            "name": name,
            "description": row["description"] or "",
            "iconUrl": row["icon_url"],
            "enabled": bool(row["enabled"]),
            "visibility": row["visibility"] or "all",
            "allowedRoles": _json_value(row["allowed_roles"], []),
            "authType": "none",
            "transport": row["transport"] or "streamable-http",
            "mcpUrl": row["mcp_url"] or "",
            "providerHeadersEncrypted": _reencrypt_embedded_iv(
                row["provider_headers_encrypted"],
                context=(
                    "connector_apps.id="
                    f"{row['id']} slug={slug} field=provider_headers_encrypted"
                ),
            ),
            "toolAllowlist": _json_value(row["tool_allowlist"], []),
            "httpTools": _json_value(row["http_tools"], []),
            "createdBy": row["created_by"],
        },
    }


def _migrate_connector_apps_to_kinds() -> None:
    if not _table_exists("connector_apps") or not _table_exists("kinds"):
        return
    bind = op.get_bind()
    connector_apps = sa.table(
        "connector_apps",
        sa.column("id", sa.Integer()),
        sa.column("slug", sa.String()),
        sa.column("name", sa.String()),
        sa.column("description", sa.Text()),
        sa.column("icon_url", sa.String()),
        sa.column("enabled", sa.Boolean()),
        sa.column("visibility", sa.String()),
        sa.column("allowed_roles", sa.JSON()),
        sa.column("transport", sa.String()),
        sa.column("mcp_url", sa.String()),
        sa.column("provider_headers_encrypted", sa.Text()),
        sa.column("tool_allowlist", sa.JSON()),
        sa.column("http_tools", sa.JSON()),
        sa.column("created_by", sa.Integer()),
        sa.column("created_at", sa.DateTime()),
        sa.column("updated_at", sa.DateTime()),
    )
    kinds = sa.table(
        "kinds",
        sa.column("user_id", sa.Integer()),
        sa.column("kind", sa.String()),
        sa.column("name", sa.String()),
        sa.column("namespace", sa.String()),
        sa.column("json", sa.JSON()),
        sa.column("is_active", sa.Boolean()),
        sa.column("created_at", sa.DateTime()),
        sa.column("updated_at", sa.DateTime()),
    )
    existing = {
        item.name
        for item in bind.execute(
            sa.text(
                "SELECT name FROM kinds "
                "WHERE kind = :kind AND namespace = :namespace AND is_active = 1"
            ),
            {"kind": CONNECTOR_APP_KIND, "namespace": CONNECTOR_APP_NAMESPACE},
        )
    }
    rows = bind.execute(sa.select(connector_apps)).mappings().all()
    for row in rows:
        if row["slug"] in existing:
            continue
        try:
            payload = _connector_payload(row)
        except EmbeddedIvReencryptError:
            logger.error(
                "Aborting ConnectorApp Kind migration before writing invalid record; "
                "connector_apps.id=%s slug=%s",
                row["id"],
                row["slug"],
            )
            raise
        bind.execute(
            kinds.insert().values(
                user_id=CONNECTOR_APP_USER_ID,
                kind=CONNECTOR_APP_KIND,
                name=row["slug"],
                namespace=CONNECTOR_APP_NAMESPACE,
                json=payload,
                is_active=True,
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
        )


def upgrade() -> None:
    _migrate_connector_apps_to_kinds()
    if _table_exists("connector_oauth_sessions"):
        op.drop_table("connector_oauth_sessions")
    if _table_exists("connector_connections"):
        op.drop_table("connector_connections")
    if _table_exists("connector_apps"):
        op.drop_table("connector_apps")


def downgrade() -> None:
    if not _table_exists("connector_apps"):
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
            sa.Column("http_tools", sa.JSON(), nullable=False),
            sa.Column("created_by", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("slug"),
        )
    if not _table_exists("connector_connections"):
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
            sa.ForeignKeyConstraint(
                ["app_id"], ["connector_apps.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "user_id", "app_id", name="uq_connector_connection_user_app"
            ),
        )
    if not _table_exists("connector_oauth_sessions"):
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
            sa.ForeignKeyConstraint(
                ["app_id"], ["connector_apps.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("state_hash"),
        )
