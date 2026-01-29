# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, EmailStr, Field, field_validator


# User Management Schemas
class AdminUserCreate(BaseModel):
    """Admin user creation model"""

    user_name: str = Field(..., min_length=2, max_length=50)
    password: Optional[str] = Field(None, min_length=6)
    email: Optional[EmailStr] = Field(None, validate_default=True)
    role: Literal["admin", "user"] = "user"
    auth_source: Literal["password", "oidc"] = "password"

    @field_validator("email", mode="before")
    @classmethod
    def empty_string_to_none(cls, v):
        """Convert empty string to None for optional email field"""
        if v == "":
            return None
        return v


class AdminUserUpdate(BaseModel):
    """Admin user update model"""

    user_name: Optional[str] = Field(None, min_length=2, max_length=50)
    email: Optional[EmailStr] = Field(None, validate_default=True)
    role: Optional[Literal["admin", "user"]] = None
    is_active: Optional[bool] = None

    @field_validator("email", mode="before")
    @classmethod
    def empty_string_to_none(cls, v):
        """Convert empty string to None for optional email field"""
        if v == "":
            return None
        return v


class PasswordReset(BaseModel):
    """Password reset model"""

    new_password: str = Field(..., min_length=6)


class AdminUserResponse(BaseModel):
    """Admin user response model"""

    id: int
    user_name: str
    email: Optional[str] = None
    role: str
    auth_source: str
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AdminUserListResponse(BaseModel):
    """Admin user list response model"""

    total: int
    items: List[AdminUserResponse]


# Public Model Management Schemas
class PublicModelCreate(BaseModel):
    """Public model creation model"""

    name: str = Field(..., min_length=1, max_length=100)
    namespace: str = Field(default="default", max_length=100)
    model_json: dict = Field(..., alias="json")

    class Config:
        populate_by_name = True


class PublicModelUpdate(BaseModel):
    """Public model update model"""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    namespace: Optional[str] = Field(None, max_length=100)
    model_json: Optional[dict] = Field(None, alias="json")
    is_active: Optional[bool] = None

    class Config:
        populate_by_name = True


class PublicModelResponse(BaseModel):
    """Public model response model"""

    id: int
    name: str
    namespace: str
    display_name: Optional[str] = None
    model_json: dict = Field(..., alias="json", serialization_alias="json")
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
        populate_by_name = True


class PublicModelListResponse(BaseModel):
    """Public model list response model"""

    total: int
    items: List[PublicModelResponse]


# System Stats Schemas
class SystemStats(BaseModel):
    """System statistics model"""

    total_users: int
    active_users: int
    admin_count: int
    total_tasks: int
    total_public_models: int


# Role Update Schema
class RoleUpdate(BaseModel):
    """Role update model"""

    role: Literal["admin", "user"]


# System Config Schemas
class SystemConfigUpdate(BaseModel):
    """System config update model for quick access recommendations"""

    teams: List[int] = Field(..., description="List of recommended team IDs")


class SystemConfigResponse(BaseModel):
    """System config response model"""

    version: int
    teams: List[int]

    class Config:
        from_attributes = True


class QuickAccessTeam(BaseModel):
    """Quick access team info"""

    id: int
    name: str
    is_system: bool = False  # True if from system recommendations
    recommended_mode: Optional[Literal["chat", "code", "both"]] = "both"
    agent_type: Optional[str] = None

    class Config:
        from_attributes = True


class QuickAccessResponse(BaseModel):
    """Quick access response with merged system recommendations"""

    system_version: int
    user_version: Optional[int] = None
    show_system_recommended: bool  # True if user_version < system_version
    teams: List[QuickAccessTeam]


# Chat Slogan & Tips Schemas
class ChatSloganItem(BaseModel):
    """Individual slogan item with multi-language support"""

    id: int = Field(..., description="Unique slogan ID")
    zh: str = Field(..., description="Chinese slogan")
    en: str = Field(..., description="English slogan")
    mode: Optional[Literal["chat", "code", "both"]] = Field(
        default="both",
        description="Which mode this slogan applies to: chat, code, or both",
    )


class ChatTipItem(BaseModel):
    """Individual tip item with multi-language support"""

    id: int = Field(..., description="Unique tip ID")
    zh: str = Field(..., description="Chinese tip text")
    en: str = Field(..., description="English tip text")
    mode: Optional[Literal["chat", "code", "both"]] = Field(
        default="both",
        description="Which mode this tip applies to: chat, code, or both",
    )


class ChatTipsConfig(BaseModel):
    """Chat tips configuration"""

    tips: List[ChatTipItem] = Field(default_factory=list, description="List of tips")


class ChatSloganTipsUpdate(BaseModel):
    """Update model for chat slogan and tips"""

    slogans: List[ChatSloganItem] = Field(..., description="List of slogans")
    tips: List[ChatTipItem] = Field(..., description="List of tips")


class ChatSloganTipsResponse(BaseModel):
    """Response model for chat slogan and tips configuration"""

    version: int = Field(..., description="Configuration version")
    slogans: List[ChatSloganItem] = Field(
        default_factory=list, description="List of slogans"
    )
    tips: List[ChatTipItem] = Field(default_factory=list, description="List of tips")

    class Config:
        from_attributes = True


class WelcomeConfigResponse(BaseModel):
    """Public response model for welcome config (slogan + tips)"""

    slogans: List[ChatSloganItem] = Field(
        default_factory=list, description="List of slogans"
    )
    tips: List[ChatTipItem] = Field(default_factory=list, description="List of tips")
    admin_setup_completed: Optional[bool] = Field(
        default=None,
        description="Whether admin setup wizard has been completed (only returned for admin users)",
    )


# Public Retriever Management Schemas
class PublicRetrieverResponse(BaseModel):
    """Public retriever response model"""

    id: int
    name: str
    namespace: str
    displayName: Optional[str] = None
    storageType: str
    description: Optional[str] = None
    retriever_json: dict = Field(..., alias="json", serialization_alias="json")
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
        populate_by_name = True


class PublicRetrieverListResponse(BaseModel):
    """Public retriever list response model"""

    total: int
    items: List[PublicRetrieverResponse]


# Subscription Monitor Schemas (formerly Flow Monitor)
class SubscriptionMonitorStats(BaseModel):
    """Subscription execution statistics for admin monitoring"""

    total_executions: int = Field(..., description="Total number of executions")
    completed_count: int = Field(..., description="Number of completed executions")
    failed_count: int = Field(..., description="Number of failed executions")
    timeout_count: int = Field(..., description="Number of timed out executions")
    cancelled_count: int = Field(..., description="Number of cancelled executions")
    running_count: int = Field(
        ..., description="Number of currently running executions"
    )
    pending_count: int = Field(..., description="Number of pending executions")
    success_rate: float = Field(..., description="Success rate (0-100)")
    failure_rate: float = Field(..., description="Failure rate (0-100)")
    timeout_rate: float = Field(..., description="Timeout rate (0-100)")
    active_subscriptions_count: int = Field(
        ..., description="Number of active subscriptions"
    )
    total_subscriptions_count: int = Field(
        ..., description="Total number of subscriptions"
    )


class SubscriptionMonitorError(BaseModel):
    """Individual error record for subscription monitor (privacy-preserving)"""

    execution_id: int = Field(..., description="Execution ID")
    subscription_id: int = Field(..., description="Subscription ID")
    user_id: int = Field(..., description="User ID")
    task_id: Optional[int] = Field(None, description="Associated task ID")
    status: str = Field(..., description="Execution status")
    error_message: Optional[str] = Field(None, description="Error message")
    trigger_type: Optional[str] = Field(None, description="Trigger type")
    created_at: datetime = Field(..., description="Creation time")
    started_at: Optional[datetime] = Field(None, description="Start time")
    completed_at: Optional[datetime] = Field(None, description="Completion time")


class SubscriptionMonitorErrorListResponse(BaseModel):
    """Error list response for subscription monitor"""

    total: int
    items: List[SubscriptionMonitorError]


# Backward compatibility aliases
FlowMonitorStats = SubscriptionMonitorStats
FlowMonitorError = SubscriptionMonitorError
FlowMonitorErrorListResponse = SubscriptionMonitorErrorListResponse


# Public Team Management Schemas
class PublicTeamCreate(BaseModel):
    """Public team creation model"""

    name: str = Field(..., min_length=1, max_length=100)
    namespace: str = Field(default="default", max_length=100)
    team_json: dict = Field(..., alias="json")

    class Config:
        populate_by_name = True


class PublicTeamUpdate(BaseModel):
    """Public team update model"""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    namespace: Optional[str] = Field(None, max_length=100)
    team_json: Optional[dict] = Field(None, alias="json")
    is_active: Optional[bool] = None

    class Config:
        populate_by_name = True


class PublicTeamResponse(BaseModel):
    """Public team response model"""

    id: int
    name: str
    namespace: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    team_json: dict = Field(..., alias="json", serialization_alias="json")
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
        populate_by_name = True


class PublicTeamListResponse(BaseModel):
    """Public team list response model"""

    total: int
    items: List[PublicTeamResponse]


# Public Bot Management Schemas
class PublicBotCreate(BaseModel):
    """Public bot creation model - supports both raw JSON and form data modes"""

    name: str = Field(..., min_length=1, max_length=100)
    namespace: str = Field(default="default", max_length=100)
    bot_json: Optional[dict] = Field(None, alias="json")

    # Form data fields (used when bot_json is not provided)
    # These fields allow creating a Bot with auto-generated Ghost
    shell_name: Optional[str] = Field(None, description="Shell name to reference")
    system_prompt: Optional[str] = Field(None, description="System prompt for Ghost")
    mcp_servers: Optional[dict] = Field(
        None, description="MCP servers config for Ghost"
    )
    skills: Optional[List[str]] = Field(None, description="Skills list for Ghost")
    agent_config: Optional[dict] = Field(None, description="Agent config for Model")

    class Config:
        populate_by_name = True


class PublicBotUpdate(BaseModel):
    """Public bot update model - supports both raw JSON and form data modes"""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    namespace: Optional[str] = Field(None, max_length=100)
    bot_json: Optional[dict] = Field(None, alias="json")
    is_active: Optional[bool] = None

    # Form data fields (used when bot_json is not provided)
    # These fields allow updating a Bot with auto-updated Ghost
    shell_name: Optional[str] = Field(None, description="Shell name to reference")
    system_prompt: Optional[str] = Field(None, description="System prompt for Ghost")
    mcp_servers: Optional[dict] = Field(
        None, description="MCP servers config for Ghost"
    )
    skills: Optional[List[str]] = Field(None, description="Skills list for Ghost")
    agent_config: Optional[dict] = Field(None, description="Agent config for Model")

    class Config:
        populate_by_name = True


class PublicBotResponse(BaseModel):
    """Public bot response model"""

    id: int
    name: str
    namespace: str
    display_name: Optional[str] = None
    bot_json: dict = Field(..., alias="json", serialization_alias="json")
    is_active: bool
    created_at: datetime
    updated_at: datetime
    # Related resource info
    ghost_name: Optional[str] = None
    shell_name: Optional[str] = None
    model_name: Optional[str] = None
    # Expanded Ghost fields for UI convenience
    system_prompt: Optional[str] = None
    mcp_servers: Optional[dict] = None
    skills: Optional[List[str]] = None
    # Expanded Model fields for UI convenience
    agent_config: Optional[dict] = None

    class Config:
        from_attributes = True
        populate_by_name = True


class PublicBotListResponse(BaseModel):
    """Public bot list response model"""

    total: int
    items: List[PublicBotResponse]


# Public Ghost Management Schemas
class PublicGhostCreate(BaseModel):
    """Public ghost creation model"""

    name: str = Field(..., min_length=1, max_length=100)
    namespace: str = Field(default="default", max_length=100)
    ghost_json: dict = Field(..., alias="json")

    class Config:
        populate_by_name = True


class PublicGhostUpdate(BaseModel):
    """Public ghost update model"""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    namespace: Optional[str] = Field(None, max_length=100)
    ghost_json: Optional[dict] = Field(None, alias="json")
    is_active: Optional[bool] = None

    class Config:
        populate_by_name = True


class PublicGhostResponse(BaseModel):
    """Public ghost response model"""

    id: int
    name: str
    namespace: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    ghost_json: dict = Field(..., alias="json", serialization_alias="json")
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
        populate_by_name = True


class PublicGhostListResponse(BaseModel):
    """Public ghost list response model"""

    total: int
    items: List[PublicGhostResponse]


# Public Shell Management Schemas
class PublicShellCreate(BaseModel):
    """Public shell creation model"""

    name: str = Field(..., min_length=1, max_length=100)
    namespace: str = Field(default="default", max_length=100)
    shell_json: dict = Field(..., alias="json")

    class Config:
        populate_by_name = True


class PublicShellUpdate(BaseModel):
    """Public shell update model"""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    namespace: Optional[str] = Field(None, max_length=100)
    shell_json: Optional[dict] = Field(None, alias="json")
    is_active: Optional[bool] = None

    class Config:
        populate_by_name = True


class PublicShellResponse(BaseModel):
    """Public shell response model"""

    id: int
    name: str
    namespace: str
    display_name: Optional[str] = None
    shell_type: Optional[str] = None
    shell_json: dict = Field(..., alias="json", serialization_alias="json")
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
        populate_by_name = True


class PublicShellListResponse(BaseModel):
    """Public shell list response model"""

    total: int
    items: List[PublicShellResponse]


# Admin Setup Wizard Schemas
class AdminSetupCompleteResponse(BaseModel):
    """Admin setup complete response model"""

    success: bool = Field(..., description="Whether the operation was successful")
    message: str = Field(..., description="Response message")
