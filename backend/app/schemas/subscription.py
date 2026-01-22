# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription (订阅) CRD schemas for automated task execution.

Subscription is a CRD resource that defines scheduled or event-triggered
task executions. It replaces the previous Flow concept.
"""
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from app.schemas.kind import ModelRef


class SubscriptionTaskType(str, Enum):
    """Subscription task type enumeration."""

    EXECUTION = "execution"
    COLLECTION = "collection"


class SubscriptionVisibility(str, Enum):
    """Subscription visibility enumeration."""

    PUBLIC = "public"  # Public: visible to all, can be followed
    PRIVATE = "private"  # Private: only visible to owner and invited users
    MARKET = "market"  # Market: visible to all, can be rented


class SubscriptionTriggerType(str, Enum):
    """Subscription trigger type enumeration."""

    CRON = "cron"
    INTERVAL = "interval"
    ONE_TIME = "one_time"
    EVENT = "event"


class SubscriptionEventType(str, Enum):
    """Event trigger sub-type enumeration."""

    WEBHOOK = "webhook"  # Webhook trigger
    GIT_PUSH = "git_push"  # Git push trigger


class BackgroundExecutionStatus(str, Enum):
    """Background execution status enumeration."""

    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    COMPLETED_SILENT = (
        "COMPLETED_SILENT"  # Silent completion (hidden from timeline by default)
    )
    FAILED = "FAILED"
    RETRYING = "RETRYING"
    CANCELLED = "CANCELLED"


# Trigger configuration schemas
class CronTriggerConfig(BaseModel):
    """Cron trigger configuration."""

    expression: str = Field(..., description="Cron expression (e.g., '0 9 * * *')")
    timezone: str = Field("UTC", description="Timezone for cron execution")


class IntervalTriggerConfig(BaseModel):
    """Interval trigger configuration."""

    value: int = Field(..., description="Interval value")
    unit: str = Field(..., description="Interval unit: 'minutes', 'hours', 'days'")


class OneTimeTriggerConfig(BaseModel):
    """One-time trigger configuration."""

    execute_at: datetime = Field(
        ..., description="Specific execution time (ISO format)"
    )


class GitPushEventConfig(BaseModel):
    """Git push event configuration."""

    repository: str = Field(..., description="Repository URL or name")
    branch: Optional[str] = Field(None, description="Branch to monitor (default: all)")


class EventTriggerConfig(BaseModel):
    """Event trigger configuration."""

    event_type: SubscriptionEventType = Field(
        ..., description="Event type: 'webhook' or 'git_push'"
    )
    git_push: Optional[GitPushEventConfig] = Field(
        None, description="Git push configuration (when event_type is 'git_push')"
    )


class SubscriptionTriggerConfig(BaseModel):
    """Subscription trigger configuration."""

    type: SubscriptionTriggerType = Field(..., description="Trigger type")
    cron: Optional[CronTriggerConfig] = Field(
        None, description="Cron configuration (when type is 'cron')"
    )
    interval: Optional[IntervalTriggerConfig] = Field(
        None, description="Interval configuration (when type is 'interval')"
    )
    one_time: Optional[OneTimeTriggerConfig] = Field(
        None, description="One-time configuration (when type is 'one_time')"
    )
    event: Optional[EventTriggerConfig] = Field(
        None, description="Event configuration (when type is 'event')"
    )


# Reference schemas
class SubscriptionTeamRef(BaseModel):
    """Reference to a Team (Agent)."""

    name: str
    namespace: str = "default"


class SubscriptionWorkspaceRef(BaseModel):
    """Reference to a Workspace (optional)."""

    name: str
    namespace: str = "default"


class SourceSubscriptionRef(BaseModel):
    """Reference to source subscription for rentals."""

    id: int = Field(..., description="Source subscription ID")
    name: str = Field(..., description="Source subscription name (for display)")
    namespace: str = Field("default", description="Source subscription namespace")


# CRD spec and status
class SubscriptionSpec(BaseModel):
    """Subscription CRD specification."""

    displayName: str = Field(..., description="User-friendly display name")
    taskType: SubscriptionTaskType = Field(
        SubscriptionTaskType.COLLECTION,
        description="Task type: 'execution' or 'collection'",
    )
    visibility: SubscriptionVisibility = Field(
        SubscriptionVisibility.PRIVATE,
        description="Visibility: 'public', 'private', or 'market'. Default is private.",
    )
    trigger: SubscriptionTriggerConfig = Field(..., description="Trigger configuration")
    teamRef: SubscriptionTeamRef = Field(
        ..., description="Reference to the Team (Agent)"
    )
    workspaceRef: Optional[SubscriptionWorkspaceRef] = Field(
        None, description="Reference to the Workspace (optional)"
    )
    modelRef: Optional[ModelRef] = Field(
        None,
        description="Reference to the Model to use for execution. "
        "If not specified, uses the default model from the Team's Bot configuration.",
    )
    forceOverrideBotModel: bool = Field(
        False,
        description="Whether to force override the Bot's predefined model with modelRef",
    )
    promptTemplate: str = Field(
        ...,
        description="Prompt template with variable support ({{date}}, {{time}}, etc.)",
    )
    retryCount: int = Field(0, ge=0, le=3, description="Retry count on failure (0-3)")
    timeoutSeconds: int = Field(
        600,
        ge=60,
        le=3600,
        description="Execution timeout in seconds (60-3600, default: 600)",
    )
    enabled: bool = Field(True, description="Whether the subscription is enabled")
    description: Optional[str] = Field(None, description="Subscription description")
    # History preservation settings
    preserveHistory: bool = Field(
        False,
        description="Whether to preserve conversation history across executions. "
        "When enabled, the subscription will reuse the same task for all executions, "
        "allowing AI to see previous conversation context.",
    )
    historyMessageCount: int = Field(
        10,
        ge=0,
        le=50,
        description="Number of recent messages to include as context (0-50, default: 10). "
        "Only effective when preserveHistory is enabled.",
    )
    # Market rental reference
    sourceSubscriptionRef: Optional[SourceSubscriptionRef] = Field(
        None,
        description="Reference to source subscription (for rentals). "
        "When set, this subscription is a rental instance.",
    )


class SubscriptionStatus(BaseModel):
    """Subscription CRD status."""

    state: str = Field(
        "Available", description="Subscription state: 'Available', 'Unavailable'"
    )
    lastExecutionTime: Optional[datetime] = Field(
        None, description="Last execution timestamp"
    )
    lastExecutionStatus: Optional[BackgroundExecutionStatus] = Field(
        None, description="Last execution status"
    )
    nextExecutionTime: Optional[datetime] = Field(
        None, description="Next scheduled execution time"
    )
    webhookUrl: Optional[str] = Field(
        None, description="Webhook URL (for event-webhook subscriptions)"
    )
    executionCount: int = Field(0, description="Total execution count")
    successCount: int = Field(0, description="Successful execution count")
    failureCount: int = Field(0, description="Failed execution count")


class SubscriptionMetadata(BaseModel):
    """Subscription CRD metadata."""

    name: str
    namespace: str = "default"
    displayName: Optional[str] = None
    labels: Optional[Dict[str, str]] = None


class Subscription(BaseModel):
    """Subscription CRD."""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Subscription"
    metadata: SubscriptionMetadata
    spec: SubscriptionSpec
    status: Optional[SubscriptionStatus] = None


class SubscriptionList(BaseModel):
    """Subscription list."""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "SubscriptionList"
    items: List[Subscription]


# API Request/Response schemas
class SubscriptionBase(BaseModel):
    """Base Subscription model for API."""

    name: str = Field(..., description="Subscription unique identifier")
    display_name: str = Field(..., description="Display name")
    description: Optional[str] = Field(None, description="Subscription description")
    task_type: SubscriptionTaskType = Field(
        SubscriptionTaskType.COLLECTION, description="Task type"
    )
    visibility: SubscriptionVisibility = Field(
        SubscriptionVisibility.PRIVATE,
        description="Visibility: 'public', 'private', or 'market'. Default is private.",
    )
    trigger_type: SubscriptionTriggerType = Field(..., description="Trigger type")
    trigger_config: Dict[str, Any] = Field(..., description="Trigger configuration")
    team_id: int = Field(..., description="Team (Agent) ID")
    workspace_id: Optional[int] = Field(None, description="Workspace ID (optional)")
    # Git repository fields (alternative to workspace_id)
    git_repo: Optional[str] = Field(
        None, description="Git repository (e.g., 'owner/repo')"
    )
    git_repo_id: Optional[int] = Field(None, description="Git repository ID")
    git_domain: Optional[str] = Field(
        None, description="Git domain (e.g., 'github.com')"
    )
    branch_name: Optional[str] = Field(None, description="Git branch name")
    # Model reference fields
    model_ref: Optional[Dict[str, str]] = Field(
        None,
        description="Model reference with 'name' and 'namespace' fields. "
        "If not specified, uses the default model from the Team's Bot configuration.",
    )
    force_override_bot_model: bool = Field(
        False,
        description="Whether to force override the Bot's predefined model with model_ref",
    )
    prompt_template: str = Field(..., description="Prompt template")
    retry_count: int = Field(0, ge=0, le=3, description="Retry count (0-3)")
    timeout_seconds: int = Field(
        600, ge=60, le=3600, description="Execution timeout (60-3600s)"
    )
    enabled: bool = Field(True, description="Whether enabled")
    # History preservation settings
    preserve_history: bool = Field(
        False,
        description="Whether to preserve conversation history across executions",
    )
    history_message_count: int = Field(
        10,
        ge=0,
        le=50,
        description="Number of recent messages to include as context (0-50)",
    )


class SubscriptionCreate(SubscriptionBase):
    """Subscription creation model."""

    namespace: str = Field("default", description="Namespace")


class SubscriptionUpdate(BaseModel):
    """Subscription update model."""

    display_name: Optional[str] = None
    description: Optional[str] = None
    task_type: Optional[SubscriptionTaskType] = None
    visibility: Optional[SubscriptionVisibility] = None
    trigger_type: Optional[SubscriptionTriggerType] = None
    trigger_config: Optional[Dict[str, Any]] = None
    team_id: Optional[int] = None
    workspace_id: Optional[int] = None
    # Git repository fields (alternative to workspace_id)
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    git_domain: Optional[str] = None
    branch_name: Optional[str] = None
    # Model reference fields
    model_ref: Optional[Dict[str, str]] = None
    force_override_bot_model: Optional[bool] = None
    prompt_template: Optional[str] = None
    retry_count: Optional[int] = Field(None, ge=0, le=3)
    timeout_seconds: Optional[int] = Field(None, ge=60, le=3600)
    enabled: Optional[bool] = None
    # History preservation settings
    preserve_history: Optional[bool] = None
    history_message_count: Optional[int] = Field(None, ge=0, le=50)


class SubscriptionInDB(SubscriptionBase):
    """Database Subscription model."""

    id: int
    user_id: int
    namespace: str = "default"
    webhook_url: Optional[str] = None
    webhook_secret: Optional[str] = None
    last_execution_time: Optional[datetime] = None
    last_execution_status: Optional[str] = None
    next_execution_time: Optional[datetime] = None
    execution_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    # Bound task ID for history preservation
    bound_task_id: Optional[int] = None
    # Visibility and follow-related fields
    followers_count: int = Field(0, description="Number of followers")
    is_following: bool = Field(False, description="Whether current user is following")
    owner_username: Optional[str] = Field(None, description="Owner's username")
    # Market rental fields
    is_rental: bool = Field(False, description="Whether this is a rental subscription")
    source_subscription_id: Optional[int] = Field(
        None, description="Source subscription ID (for rentals)"
    )
    source_subscription_name: Optional[str] = Field(
        None, description="Source subscription name (for rentals)"
    )
    source_subscription_display_name: Optional[str] = Field(
        None, description="Source subscription display name (for rentals)"
    )
    source_owner_username: Optional[str] = Field(
        None, description="Source subscription owner username (for rentals)"
    )
    rental_count: int = Field(
        0, description="Number of rentals (for market subscriptions)"
    )
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SubscriptionListResponse(BaseModel):
    """Subscription list response."""

    total: int
    items: List[SubscriptionInDB]


# Background Execution schemas
class BackgroundExecutionBase(BaseModel):
    """Base Background Execution model."""

    subscription_id: int
    trigger_type: str = Field(..., description="What triggered this execution")
    trigger_reason: Optional[str] = Field(
        None, description="Human-readable trigger reason"
    )
    prompt: str = Field(..., description="Resolved prompt (with variables substituted)")


class BackgroundExecutionCreate(BackgroundExecutionBase):
    """Background Execution creation model."""

    task_id: Optional[int] = Field(None, description="Associated Task ID")


class BackgroundExecutionInDB(BackgroundExecutionBase):
    """Database Background Execution model."""

    id: int
    user_id: int
    task_id: Optional[int] = None
    status: BackgroundExecutionStatus = BackgroundExecutionStatus.PENDING
    result_summary: Optional[str] = None
    error_message: Optional[str] = None
    retry_attempt: int = 0
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    # Joined fields for display
    subscription_name: Optional[str] = None
    subscription_display_name: Optional[str] = None
    team_name: Optional[str] = None
    task_type: Optional[str] = None
    # Permission field - indicates if current user can delete this execution
    can_delete: bool = Field(
        False,
        description="Whether the current user can delete this execution. "
        "Only the subscription owner can delete executions.",
    )

    class Config:
        from_attributes = True


class BackgroundExecutionDetail(BackgroundExecutionInDB):
    """Detailed Background Execution with task info."""

    task_detail: Optional[Dict[str, Any]] = None


class BackgroundExecutionListResponse(BaseModel):
    """Background Execution list response (timeline)."""

    total: int
    items: List[BackgroundExecutionInDB]


# Timeline filter schemas
class SubscriptionTimelineFilter(BaseModel):
    """Filter options for subscription timeline."""

    time_range: Optional[str] = Field(
        "7d", description="Time range: 'today', '7d', '30d', 'custom'"
    )
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    status: Optional[List[BackgroundExecutionStatus]] = None
    subscription_ids: Optional[List[int]] = None
    team_ids: Optional[List[int]] = None
    task_types: Optional[List[SubscriptionTaskType]] = None


# Subscription Trigger Payload for AI Response
class SubscriptionTriggerPayload(BaseModel):
    """
    Payload for triggering AI response in Subscription tasks.

    This replaces the inline FlowPayload class in subscription_tasks.py to follow
    DRY principles and proper software engineering practices.
    """

    force_override_bot_model: Optional[str] = None
    enable_clarification: bool = False
    enable_deep_thinking: bool = True
    is_group_chat: bool = False
    enable_web_search: bool = False
    search_engine: Optional[str] = None
    preload_skills: Optional[List[str]] = None


# ========== Subscription Follow/Visibility Schemas ==========


class FollowType(str, Enum):
    """Follow type enumeration."""

    DIRECT = "direct"
    INVITED = "invited"


class InvitationStatus(str, Enum):
    """Invitation status enumeration."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class SubscriptionFollowBase(BaseModel):
    """Base schema for subscription follow."""

    subscription_id: int
    follower_user_id: int
    follow_type: FollowType = FollowType.DIRECT


class SubscriptionFollowInDB(SubscriptionFollowBase):
    """Subscription follow record in database."""

    id: int
    invited_by_user_id: Optional[int] = None
    invitation_status: InvitationStatus = InvitationStatus.PENDING
    invited_at: Optional[datetime] = None
    responded_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    # Enriched fields
    subscription_name: Optional[str] = None
    subscription_display_name: Optional[str] = None
    follower_username: Optional[str] = None
    invited_by_username: Optional[str] = None

    class Config:
        from_attributes = True


class SubscriptionFollowerResponse(BaseModel):
    """Response for listing followers of a subscription."""

    user_id: int
    username: str
    follow_type: FollowType
    followed_at: datetime


class SubscriptionFollowersListResponse(BaseModel):
    """Response for listing followers with pagination."""

    total: int
    items: List[SubscriptionFollowerResponse]


class FollowingSubscriptionResponse(BaseModel):
    """Response for subscriptions a user follows."""

    subscription: SubscriptionInDB
    follow_type: FollowType
    followed_at: datetime


class FollowingSubscriptionsListResponse(BaseModel):
    """Response for listing followed subscriptions with pagination."""

    total: int
    items: List[FollowingSubscriptionResponse]


class InviteUserRequest(BaseModel):
    """Request to invite a user to follow a subscription."""

    user_id: Optional[int] = Field(None, description="User ID to invite")
    email: Optional[str] = Field(
        None, description="Email to invite (alternative to user_id)"
    )


class InviteNamespaceRequest(BaseModel):
    """Request to invite a namespace (group) to follow a subscription."""

    namespace_id: int = Field(..., description="Namespace ID to invite")


class SubscriptionInvitationResponse(BaseModel):
    """Response for a subscription invitation."""

    id: int
    subscription_id: int
    subscription_name: str
    subscription_display_name: str
    invited_by_user_id: int
    invited_by_username: str
    invitation_status: InvitationStatus
    invited_at: datetime
    owner_username: str


class SubscriptionInvitationsListResponse(BaseModel):
    """Response for listing invitations."""

    total: int
    items: List[SubscriptionInvitationResponse]


class DiscoverSubscriptionResponse(BaseModel):
    """Response for a subscription in the discover list."""

    id: int
    name: str
    display_name: str
    description: Optional[str] = None
    task_type: SubscriptionTaskType
    owner_user_id: int
    owner_username: str
    followers_count: int
    is_following: bool
    created_at: datetime
    updated_at: datetime


class DiscoverSubscriptionsListResponse(BaseModel):
    """Response for the discover subscriptions list."""

    total: int
    items: List[DiscoverSubscriptionResponse]


# ========== Market/Rental Schemas ==========


class MarketSubscriptionDetail(BaseModel):
    """Market subscription detail (hides sensitive information)."""

    id: int = Field(..., description="Subscription ID")
    name: str = Field(..., description="Subscription name")
    display_name: str = Field(..., description="Display name")
    description: Optional[str] = Field(None, description="Subscription description")
    task_type: SubscriptionTaskType = Field(..., description="Task type")
    trigger_type: SubscriptionTriggerType = Field(..., description="Trigger type")
    trigger_description: str = Field(
        ..., description="Human-readable trigger description"
    )
    owner_user_id: int = Field(..., description="Owner user ID")
    owner_username: str = Field(..., description="Owner username")
    rental_count: int = Field(0, description="Number of rentals")
    is_rented: bool = Field(False, description="Whether current user has rented this")
    created_at: datetime
    updated_at: datetime
    # Note: Does not include prompt_template, team_ref, workspace_ref


class MarketSubscriptionsListResponse(BaseModel):
    """Response for market subscriptions list."""

    total: int
    items: List[MarketSubscriptionDetail]


class RentSubscriptionRequest(BaseModel):
    """Request to rent a market subscription."""

    name: str = Field(..., description="Rental subscription name (unique identifier)")
    display_name: str = Field(..., description="Display name for the rental")
    trigger_type: SubscriptionTriggerType = Field(..., description="Trigger type")
    trigger_config: Dict[str, Any] = Field(..., description="Trigger configuration")
    model_ref: Optional[Dict[str, str]] = Field(
        None, description="Optional model reference (name, namespace)"
    )


class RentalSubscriptionResponse(BaseModel):
    """Response for a rental subscription."""

    id: int = Field(..., description="Rental subscription ID")
    name: str = Field(..., description="Rental subscription name")
    display_name: str = Field(..., description="Display name")
    namespace: str = Field("default", description="Namespace")
    source_subscription_id: int = Field(..., description="Source subscription ID")
    source_subscription_name: str = Field(..., description="Source subscription name")
    source_subscription_display_name: str = Field(
        ..., description="Source subscription display name"
    )
    source_owner_user_id: int = Field(..., description="Source owner user ID")
    source_owner_username: str = Field(..., description="Source owner username")
    trigger_type: SubscriptionTriggerType = Field(..., description="Trigger type")
    trigger_config: Dict[str, Any] = Field(..., description="Trigger configuration")
    model_ref: Optional[Dict[str, str]] = Field(None, description="Model reference")
    enabled: bool = Field(True, description="Whether enabled")
    last_execution_time: Optional[datetime] = Field(
        None, description="Last execution time"
    )
    last_execution_status: Optional[str] = Field(
        None, description="Last execution status"
    )
    next_execution_time: Optional[datetime] = Field(
        None, description="Next execution time"
    )
    execution_count: int = Field(0, description="Execution count")
    created_at: datetime
    updated_at: datetime


class RentalSubscriptionsListResponse(BaseModel):
    """Response for rental subscriptions list."""

    total: int
    items: List[RentalSubscriptionResponse]


class RentalCountResponse(BaseModel):
    """Response for rental count."""

    subscription_id: int
    rental_count: int
