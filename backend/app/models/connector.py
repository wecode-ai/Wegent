# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persistent models for administrator-managed connector applications."""

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.db.base import Base


class ConnectorApp(Base):
    """An administrator-managed app backed by a remote MCP server."""

    __tablename__ = "connector_apps"

    id = Column(Integer, primary_key=True, index=True)
    slug = Column(String(100), nullable=False, unique=True, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=False, default="")
    icon_url = Column(String(2048), nullable=True)
    enabled = Column(Boolean, nullable=False, default=True, index=True)
    visibility = Column(String(32), nullable=False, default="all")
    allowed_roles = Column(JSON, nullable=False, default=list)
    auth_type = Column(String(32), nullable=False, default="none")
    transport = Column(String(32), nullable=False, default="streamable-http")
    mcp_url = Column(String(2048), nullable=False)
    oauth_authorization_url = Column(String(2048), nullable=True)
    oauth_token_url = Column(String(2048), nullable=True)
    oauth_client_id = Column(String(512), nullable=True)
    oauth_client_auth_method = Column(
        String(32), nullable=False, default="client_secret_post"
    )
    oauth_client_secret_encrypted = Column(Text, nullable=True)
    oauth_scopes = Column(JSON, nullable=False, default=list)
    provider_headers_encrypted = Column(Text, nullable=True)
    tool_allowlist = Column(JSON, nullable=False, default=list)
    http_tools = Column(JSON, nullable=False, default=list)
    created_by = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ConnectorConnection(Base):
    """A user's authorized account for one connector app."""

    __tablename__ = "connector_connections"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    app_id = Column(
        Integer,
        ForeignKey("connector_apps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status = Column(String(32), nullable=False, default="connected", index=True)
    external_account_id = Column(String(512), nullable=True)
    external_account_name = Column(String(512), nullable=True)
    access_token_encrypted = Column(Text, nullable=True)
    refresh_token_encrypted = Column(Text, nullable=True)
    token_type = Column(String(64), nullable=True)
    granted_scopes = Column(JSON, nullable=False, default=list)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("user_id", "app_id", name="uq_connector_connection_user_app"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ConnectorOAuthSession(Base):
    """Single-use OAuth state bound to one user and connector app."""

    __tablename__ = "connector_oauth_sessions"

    id = Column(Integer, primary_key=True, index=True)
    state_hash = Column(String(64), nullable=False, unique=True, index=True)
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    app_id = Column(
        Integer,
        ForeignKey("connector_apps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    redirect_uri = Column(String(2048), nullable=False)
    code_verifier_encrypted = Column(Text, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    consumed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
