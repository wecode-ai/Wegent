# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IMChannel model for storing IM channel configurations.

Supports multiple IM platforms (DingTalk, Feishu, WeChat) with encrypted
secret storage and per-channel configuration.
"""

from typing import Any, ClassVar, Dict, Literal, Optional

from sqlalchemy import JSON, Boolean, Column, DateTime, Integer, String
from sqlalchemy.sql import func

from app.db.base import Base

# Channel type literals
ChannelType = Literal["dingtalk", "feishu", "wechat"]


class IMChannel(Base):
    """
    IM Channel configuration model.

    Stores configuration for various IM platform integrations (DingTalk, Feishu, WeChat).
    Sensitive fields like client secrets are encrypted before storage.
    """

    __tablename__ = "im_channels"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False, comment="Channel display name")
    channel_type = Column(
        String(50),
        nullable=False,
        index=True,
        comment="Channel type: dingtalk/feishu/wechat",
    )
    is_enabled = Column(
        Boolean, default=True, nullable=False, comment="Whether channel is enabled"
    )

    # Channel configuration stored as JSON
    # DingTalk example: {"client_id": "xxx", "client_secret": "encrypted...", "use_ai_card": true}
    _config = Column(
        "config", JSON, nullable=False, comment="Channel configuration in JSON format"
    )

    # Default team for this channel (0 means none, no foreign key for flexibility)
    default_team_id = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Default team ID for messages from this channel, 0 means none",
    )

    # Default model name for this channel (overrides bot's model configuration)
    default_model_name = Column(
        String(100),
        nullable=False,
        default="",
        comment="Default model name to override bot's model, empty means use bot's default",
    )

    # Audit fields
    created_at = Column(
        DateTime,
        server_default=func.now(),
        nullable=False,
        comment="Record creation time",
    )
    updated_at = Column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
        comment="Record update time",
    )
    create_user_id = Column(
        Integer,
        nullable=False,
        default=0,
        comment="User ID who created this channel, 0 means system",
    )

    # Runtime status (not persisted, used by ChannelManager)
    _runtime_status: ClassVar[Optional[Dict[str, Any]]] = None

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    @property
    def config(self) -> Dict[str, Any]:
        """Get config as a dictionary."""
        return self._config if self._config else {}

    @config.setter
    def config(self, value: Optional[Dict[str, Any]]) -> None:
        """Set config from a dictionary."""
        self._config = value if value else {}

    def get_masked_config(self) -> Dict[str, Any]:
        """
        Get config with sensitive fields masked.

        Returns config dictionary with secret/token fields replaced with '***'.
        Used for API responses to avoid exposing sensitive data.
        """
        config = self.config.copy()
        sensitive_keys = {
            "client_secret",
            "secret",
            "token",
            "access_token",
            "app_secret",
        }
        for key in config:
            if any(sk in key.lower() for sk in sensitive_keys):
                config[key] = "***"
        return config

    def __repr__(self) -> str:
        return f"<IMChannel(id={self.id}, name='{self.name}', type='{self.channel_type}', enabled={self.is_enabled})>"
