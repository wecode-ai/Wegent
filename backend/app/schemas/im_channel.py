# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for IM Channel (Messager CRD) management.

IM channels are stored in the kinds table with kind="Messager".
"""

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

# Channel type literals
ChannelType = Literal["dingtalk", "feishu", "wechat", "telegram"]


class MessagerSpec(BaseModel):
    """Spec for Messager CRD."""

    channelType: ChannelType = Field(
        ..., description="Channel type: dingtalk, feishu, wechat, telegram"
    )
    isEnabled: bool = Field(default=True, description="Whether channel is enabled")
    config: Dict[str, Any] = Field(
        ..., description="Channel configuration (varies by type)"
    )
    defaultTeamId: int = Field(0, description="Default team ID for messages")
    defaultModelName: str = Field(
        "", description="Default model name to override bot's model"
    )


class IMChannelCreate(BaseModel):
    """Schema for creating a new IM channel (Messager CRD)."""

    name: str = Field(
        ..., min_length=1, max_length=100, description="Channel display name"
    )
    namespace: str = Field(default="default", description="Namespace")
    channel_type: ChannelType = Field(
        ..., description="Channel type: dingtalk, feishu, wechat, telegram"
    )
    config: Dict[str, Any] = Field(
        ..., description="Channel configuration (varies by type)"
    )
    default_team_id: Optional[int] = Field(
        None, description="Default team ID for messages"
    )
    default_model_name: Optional[str] = Field(
        None, max_length=100, description="Default model name to override bot's model"
    )
    is_enabled: bool = Field(default=True, description="Whether channel is enabled")

    @field_validator("config")
    @classmethod
    def validate_config(cls, v: Dict[str, Any], info) -> Dict[str, Any]:
        """Validate config has required fields based on channel type."""
        return v


class IMChannelUpdate(BaseModel):
    """Schema for updating an existing IM channel."""

    name: Optional[str] = Field(
        None, min_length=1, max_length=100, description="Channel display name"
    )
    is_enabled: Optional[bool] = Field(None, description="Whether channel is enabled")
    config: Optional[Dict[str, Any]] = Field(None, description="Channel configuration")
    default_team_id: Optional[int] = Field(
        None, description="Default team ID for messages"
    )
    default_model_name: Optional[str] = Field(
        None, max_length=100, description="Default model name to override bot's model"
    )


class IMChannelResponse(BaseModel):
    """Schema for IM channel API response."""

    id: int
    name: str
    namespace: str = "default"
    channel_type: str
    is_enabled: bool
    config: Dict[str, Any] = Field(
        ..., description="Channel configuration (sensitive fields masked with ***)"
    )
    default_team_id: int = Field(0, description="Default team ID, 0 means none")
    default_model_name: str = Field(
        "",
        description="Default model name to override bot's model, empty means use bot's default",
    )
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class IMChannelListResponse(BaseModel):
    """Schema for paginated IM channel list response."""

    total: int
    items: List[IMChannelResponse]


class IMChannelStatus(BaseModel):
    """Schema for IM channel connection status."""

    id: int
    name: str
    channel_type: str
    is_enabled: bool
    is_connected: bool = Field(
        ..., description="Whether channel is currently connected"
    )
    last_error: Optional[str] = Field(None, description="Last error message if any")
    uptime_seconds: Optional[float] = Field(
        None, description="Connection uptime in seconds"
    )
    extra_info: Optional[Dict[str, Any]] = Field(
        None, description="Additional status info"
    )


# User mapping mode literals
UserMappingMode = Literal["staff_id", "email", "select_user"]


# Channel-specific config schemas for documentation and validation
class DingTalkChannelConfig(BaseModel):
    """Configuration schema for DingTalk channel."""

    client_id: str = Field(..., description="DingTalk application Client ID")
    client_secret: str = Field(..., description="DingTalk application Client secret")
    use_ai_card: bool = Field(
        default=True, description="Use AI Card for streaming responses"
    )
    # User mapping mode: how to map DingTalk users to Wegent users
    # - "staff_id": Use DingTalk staff_id as username (default)
    # - "email": Match user by email address
    # - "select_user": Map all DingTalk users to a specific Wegent user
    user_mapping_mode: UserMappingMode = Field(
        default="select_user",
        description="User mapping mode: staff_id, email, or select_user",
    )
    # User mapping config: additional configuration based on mode
    # For "select_user" mode: {"target_user_id": 123}
    user_mapping_config: Optional[Dict[str, Any]] = Field(
        default=None,
        description="User mapping configuration. For select_user mode: {target_user_id: int}",
    )


class FeishuChannelConfig(BaseModel):
    """Configuration schema for Feishu (Lark) channel."""

    app_id: str = Field(..., description="Feishu application App ID")
    app_secret: str = Field(..., description="Feishu application App secret")
    verification_token: Optional[str] = Field(
        None, description="Event verification token"
    )
    encrypt_key: Optional[str] = Field(None, description="Event encryption key")


class WeChatChannelConfig(BaseModel):
    """Configuration schema for WeChat Work channel."""

    corp_id: str = Field(..., description="WeChat Work Corp ID")
    secret: str = Field(..., description="WeChat Work application secret")
    agent_id: int = Field(..., description="WeChat Work Agent ID")
    token: Optional[str] = Field(None, description="Callback token")
    encoding_aes_key: Optional[str] = Field(None, description="Callback EncodingAESKey")


class TelegramChannelConfig(BaseModel):
    """Configuration schema for Telegram channel."""

    bot_token: str = Field(..., description="Telegram Bot Token from @BotFather")
    # User mapping mode: how to map Telegram users to Wegent users
    # - "select_user": Map all Telegram users to a specific Wegent user (default)
    # - "username": Match Telegram username with Wegent username
    # - "chat_id": Use Telegram chat_id for user binding (requires manual setup)
    user_mapping_mode: UserMappingMode = Field(
        default="select_user",
        description="User mapping mode: select_user, staff_id (for chat_id), or email (for username)",
    )
    # User mapping config: additional configuration based on mode
    # For "select_user" mode: {"target_user_id": 123}
    user_mapping_config: Optional[Dict[str, Any]] = Field(
        default=None,
        description="User mapping configuration. For select_user mode: {target_user_id: int}",
    )
    # Enable inline keyboard for interactive commands
    use_inline_keyboard: bool = Field(
        default=True,
        description="Use inline keyboard buttons for interactive commands",
    )
