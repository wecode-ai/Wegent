# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persistent, revocable OAuth refresh-token records."""

from datetime import datetime

from sqlalchemy import Column, DateTime, Index, Integer, String, UniqueConstraint
from sqlalchemy.sql import func

from app.db.base import Base

OAUTH_REFRESH_TOKEN_UNSET_TIME = datetime(1970, 1, 1, 0, 0, 0)


class OAuthRefreshToken(Base):
    __tablename__ = "oauth_refresh_tokens"

    id = Column(
        Integer,
        primary_key=True,
        autoincrement=True,
        comment="Primary key",
    )
    token_hash = Column(
        String(64),
        nullable=False,
        default="",
        server_default="",
        comment="SHA-256 hash of the refresh token",
    )
    token_prefix = Column(
        String(16),
        nullable=False,
        default="",
        server_default="",
        comment="Non-secret token prefix for diagnostics",
    )
    family_id = Column(
        String(36),
        nullable=False,
        default="",
        server_default="",
        comment="Refresh-token rotation family UUID",
    )
    client_kind_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="OAuth client kinds.id; 0 means unset",
    )
    user_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Authorizing users.id; 0 means unset",
    )
    expires_at = Column(
        DateTime,
        nullable=False,
        default=OAUTH_REFRESH_TOKEN_UNSET_TIME,
        server_default="1970-01-01 00:00:00",
        comment="Expiration time",
    )
    used_at = Column(
        DateTime,
        nullable=False,
        default=OAUTH_REFRESH_TOKEN_UNSET_TIME,
        server_default="1970-01-01 00:00:00",
        comment="Rotation time; epoch means unused",
    )
    revoked_at = Column(
        DateTime,
        nullable=False,
        default=OAUTH_REFRESH_TOKEN_UNSET_TIME,
        server_default="1970-01-01 00:00:00",
        comment="Revocation time; epoch means active",
    )
    replaced_by_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Replacement token row id; 0 means unset",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        server_default=func.now(),
        comment="Creation time",
    )

    __table_args__ = (
        UniqueConstraint(
            "token_hash",
            name="uniq_oauth_refresh_tokens_token_hash",
        ),
        Index("idx_oauth_refresh_tokens_family_id", "family_id"),
        Index("idx_oauth_refresh_tokens_client_kind_id", "client_kind_id"),
        Index("idx_oauth_refresh_tokens_user_id", "user_id"),
        Index("idx_oauth_refresh_tokens_expires_at", "expires_at"),
        Index("idx_oauth_refresh_tokens_revoked_at", "revoked_at"),
        {
            "comment": "OAuth refresh-token rotation and revocation records",
            "mysql_charset": "utf8mb4",
            "mysql_engine": "InnoDB",
        },
    )
