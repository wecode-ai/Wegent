# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Integration Schemas.

Pydantic models for IM integration API requests and responses.
"""

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class IMPlatform(str, Enum):
    """Supported IM platforms."""

    TELEGRAM = "telegram"
    SLACK = "slack"
    DISCORD = "discord"
    FEISHU = "feishu"
    DINGTALK = "dingtalk"
    WECHAT = "wechat"


class IMIntegrationConfig(BaseModel):
    """Single IM integration configuration."""

    provider: IMPlatform = Field(..., description="IM platform identifier")
    enabled: bool = Field(default=False, description="Whether this integration is enabled")
    config: Dict[str, Any] = Field(
        default_factory=dict,
        description="Platform-specific configuration (tokens are encrypted)",
    )


class IMIntegrationStatus(BaseModel):
    """IM integration status for API responses."""

    provider: IMPlatform = Field(..., description="IM platform identifier")
    enabled: bool = Field(..., description="Whether this integration is enabled")
    connected: bool = Field(
        default=False, description="Whether the bot is currently connected"
    )
    bot_username: Optional[str] = Field(None, description="Bot username on the platform")
    error: Optional[str] = Field(None, description="Error message if connection failed")


class ValidateIMConfigRequest(BaseModel):
    """Request to validate an IM configuration."""

    provider: IMPlatform = Field(..., description="IM platform to validate")
    config: Dict[str, Any] = Field(
        ..., description="Platform-specific configuration to validate"
    )


class ValidateIMConfigResponse(BaseModel):
    """Response for IM configuration validation."""

    valid: bool = Field(..., description="Whether the configuration is valid")
    error: Optional[str] = Field(None, description="Error message if invalid")
    bot_info: Optional[Dict[str, Any]] = Field(
        None, description="Bot information if validation succeeded"
    )


class IMPlatformInfo(BaseModel):
    """Information about an available IM platform."""

    id: str = Field(..., description="Platform identifier")
    name: str = Field(..., description="Platform display name")
    description: Optional[str] = Field(None, description="Platform description")
    config_fields: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Configuration fields required for this platform",
    )


class ListPlatformsResponse(BaseModel):
    """Response for listing available IM platforms."""

    platforms: List[IMPlatformInfo] = Field(
        ..., description="List of available platforms"
    )


# Platform configuration field definitions
PLATFORM_CONFIG_FIELDS = {
    IMPlatform.TELEGRAM: [
        {
            "name": "token",
            "label": "Bot Token",
            "type": "password",
            "required": True,
            "description": "Get your bot token from @BotFather on Telegram",
        }
    ],
    IMPlatform.SLACK: [
        {
            "name": "bot_token",
            "label": "Bot Token",
            "type": "password",
            "required": True,
            "description": "Slack Bot User OAuth Token (starts with xoxb-)",
        },
        {
            "name": "app_token",
            "label": "App Token",
            "type": "password",
            "required": True,
            "description": "Slack App-Level Token (starts with xapp-)",
        },
    ],
    IMPlatform.DISCORD: [
        {
            "name": "token",
            "label": "Bot Token",
            "type": "password",
            "required": True,
            "description": "Discord Bot Token from Developer Portal",
        }
    ],
    IMPlatform.FEISHU: [
        {
            "name": "app_id",
            "label": "App ID",
            "type": "text",
            "required": True,
            "description": "Feishu App ID",
        },
        {
            "name": "app_secret",
            "label": "App Secret",
            "type": "password",
            "required": True,
            "description": "Feishu App Secret",
        },
    ],
}
