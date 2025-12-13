# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription schemas for Smart Feed feature
"""
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class TriggerType(str, Enum):
    """Trigger type for subscription"""

    CRON = "cron"
    WEBHOOK = "webhook"


class SubscriptionRunStatus(str, Enum):
    """Status for subscription run"""

    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


# Subscription Schemas
class CronConfig(BaseModel):
    """Cron trigger configuration"""

    expression: str = Field(..., description="Cron expression, e.g., '0 */30 * * * *'")
    timezone: str = Field(default="Asia/Shanghai", description="Timezone for cron")


class WebhookConfig(BaseModel):
    """Webhook trigger configuration"""

    secret: Optional[str] = Field(None, description="secret for webhook verification")


class TriggerConfig(BaseModel):
    """Trigger configuration"""

    type: TriggerType = Field(..., description="Trigger type: cron or webhook")
    cron: Optional[CronConfig] = None
    webhook: Optional[WebhookConfig] = None


class AlertPolicy(BaseModel):
    """Alert policy configuration"""

    enabled: bool = Field(default=True, description="Whether to enable alert")
    prompt: Optional[str] = Field(
        None, description="AI prompt for determining if alert is needed"
    )
    keywords: Optional[List[str]] = Field(None, description="Keywords for AI reference")


class RetentionConfig(BaseModel):
    """Data retention configuration"""

    days: int = Field(default=30, description="Days to retain data")


class TeamRef(BaseModel):
    """Team reference"""

    name: str
    namespace: str = "default"


class SubscriptionBase(BaseModel):
    """Base subscription model"""

    name: str = Field(..., max_length=100, description="Subscription name")
    description: Optional[str] = Field(None, description="Subscription description")
    namespace: str = Field(default="default", description="Namespace")


class SubscriptionCreate(SubscriptionBase):
    """Subscription creation model"""

    team_id: Optional[int] = Field(None, description="Team ID (takes priority)")
    team_name: Optional[str] = Field(None, description="Team name")
    team_namespace: Optional[str] = Field(
        default="default", description="Team namespace"
    )
    trigger: TriggerConfig
    alert_policy: Optional[AlertPolicy] = None
    retention: Optional[RetentionConfig] = None
    enabled: bool = True


class SubscriptionUpdate(BaseModel):
    """Subscription update model"""

    name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = None
    team_id: Optional[int] = None
    team_name: Optional[str] = None
    team_namespace: Optional[str] = None
    trigger: Optional[TriggerConfig] = None
    alert_policy: Optional[AlertPolicy] = None
    retention: Optional[RetentionConfig] = None
    enabled: Optional[bool] = None


class SubscriptionInDB(SubscriptionBase):
    """Database subscription model"""

    id: int
    user_id: int
    team_id: int
    team_name: str
    team_namespace: str
    trigger_type: str
    cron_expression: Optional[str] = None
    cron_timezone: Optional[str] = None
    webhook_secret: Optional[str] = None
    alert_enabled: bool = True
    alert_prompt: Optional[str] = None
    alert_keywords: Optional[List[str]] = None
    retention_days: int = 30
    enabled: bool = True
    last_run_time: Optional[datetime] = None
    last_run_status: Optional[str] = None
    unread_count: int = 0
    total_item_count: int = 0
    is_active: bool = True
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SubscriptionListResponse(BaseModel):
    """Subscription list response"""

    total: int
    items: List[SubscriptionInDB]


# Subscription Item Schemas
# Subscription Item Schemas
class SubscriptionItemBase(BaseModel):
    """Base subscription item model"""

    title: str = Field(..., max_length=500, description="Item title")
    content: Optional[str] = Field(None, description="Item content in markdown")
    summary: Optional[str] = Field(None, description="AI generated summary")
    source_url: Optional[str] = Field(None, max_length=1000, description="Source URL")
    item_metadata: Optional[Dict[str, Any]] = Field(
        None, description="Extended metadata"
    )


class SubscriptionItemCreate(SubscriptionItemBase):
    """Subscription item creation model"""

    subscription_id: int
    should_alert: bool = False
    alert_reason: Optional[str] = None
    task_id: Optional[int] = None
    run_id: Optional[int] = None


class SubscriptionItemInDB(SubscriptionItemBase):
    """Database subscription item model"""

    id: int
    subscription_id: int
    should_alert: bool = False
    alert_reason: Optional[str] = None
    is_read: bool = False
    task_id: Optional[int] = None
    run_id: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class SubscriptionItemListResponse(BaseModel):
    """Subscription item list response"""

    total: int
    items: List[SubscriptionItemInDB]


class MarkReadRequest(BaseModel):
    """Mark item as read request"""

    item_ids: Optional[List[int]] = Field(
        None, description="Item IDs to mark as read, if None mark all"
    )


# Subscription Run Schemas
class SubscriptionRunInDB(BaseModel):
    """Database subscription run model"""

    id: int
    subscription_id: int
    task_id: Optional[int] = None
    status: str
    items_collected: int = 0
    items_alerted: int = 0
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error_message: Optional[str] = None

    class Config:
        from_attributes = True


class SubscriptionRunListResponse(BaseModel):
    """Subscription run list response"""

    total: int
    items: List[SubscriptionRunInDB]


# Webhook Schemas
class WebhookTriggerRequest(BaseModel):
    """Webhook trigger request"""

    secret: Optional[str] = Field(None, description="secret for verification")
    data: Optional[Dict[str, Any]] = Field(None, description="Additional data")


class WebhookTriggerResponse(BaseModel):
    """Webhook trigger response"""

    success: bool
    message: str
    run_id: Optional[int] = None


# Summary Schemas
class UnreadCountResponse(BaseModel):
    """Unread count response"""

    total_unread: int
    subscriptions: List[Dict[str, Any]] = Field(
        default_factory=list, description="Unread count per subscription"
    )


class FeedSummaryRequest(BaseModel):
    """Feed summary request"""

    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    subscription_ids: Optional[List[int]] = None


class FeedSummaryResponse(BaseModel):
    """Feed summary response"""

    summary: str
    item_count: int
    alert_count: int
    period: Dict[str, Any]
