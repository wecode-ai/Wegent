# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Flow (智能流) CRD schemas for automated task execution.
"""
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class FlowTaskType(str, Enum):
    """Flow task type enumeration."""

    EXECUTION = "execution"  # 执行类任务
    COLLECTION = "collection"  # 信息采集类任务


class FlowTriggerType(str, Enum):
    """Flow trigger type enumeration."""

    CRON = "cron"  # 定时计划
    INTERVAL = "interval"  # 固定间隔
    ONE_TIME = "one_time"  # 一次性定时
    EVENT = "event"  # 事件触发


class FlowEventType(str, Enum):
    """Event trigger sub-type enumeration."""

    WEBHOOK = "webhook"  # Webhook 触发
    GIT_PUSH = "git_push"  # Git Push 触发


class FlowExecutionStatus(str, Enum):
    """Flow execution status enumeration."""

    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
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
    unit: str = Field(
        ..., description="Interval unit: 'minutes', 'hours', 'days'"
    )


class OneTimeTriggerConfig(BaseModel):
    """One-time trigger configuration."""

    execute_at: datetime = Field(..., description="Specific execution time (ISO format)")


class GitPushEventConfig(BaseModel):
    """Git push event configuration."""

    repository: str = Field(..., description="Repository URL or name")
    branch: Optional[str] = Field(None, description="Branch to monitor (default: all)")


class EventTriggerConfig(BaseModel):
    """Event trigger configuration."""

    event_type: FlowEventType = Field(..., description="Event type: 'webhook' or 'git_push'")
    git_push: Optional[GitPushEventConfig] = Field(
        None, description="Git push configuration (when event_type is 'git_push')"
    )


class FlowTriggerConfig(BaseModel):
    """Flow trigger configuration."""

    type: FlowTriggerType = Field(..., description="Trigger type")
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
class FlowTeamRef(BaseModel):
    """Reference to a Team (Agent)."""

    name: str
    namespace: str = "default"


class FlowWorkspaceRef(BaseModel):
    """Reference to a Workspace (optional)."""

    name: str
    namespace: str = "default"


# CRD spec and status
class FlowSpec(BaseModel):
    """Flow CRD specification."""

    displayName: str = Field(..., description="User-friendly display name")
    taskType: FlowTaskType = Field(
        FlowTaskType.COLLECTION, description="Task type: 'execution' or 'collection'"
    )
    trigger: FlowTriggerConfig = Field(..., description="Trigger configuration")
    teamRef: FlowTeamRef = Field(..., description="Reference to the Team (Agent)")
    workspaceRef: Optional[FlowWorkspaceRef] = Field(
        None, description="Reference to the Workspace (optional)"
    )
    promptTemplate: str = Field(
        ..., description="Prompt template with variable support ({{date}}, {{time}}, etc.)"
    )
    retryCount: int = Field(0, ge=0, le=3, description="Retry count on failure (0-3)")
    enabled: bool = Field(True, description="Whether the flow is enabled")
    description: Optional[str] = Field(None, description="Flow description")


class FlowStatus(BaseModel):
    """Flow CRD status."""

    state: str = Field("Available", description="Flow state: 'Available', 'Unavailable'")
    lastExecutionTime: Optional[datetime] = Field(
        None, description="Last execution timestamp"
    )
    lastExecutionStatus: Optional[FlowExecutionStatus] = Field(
        None, description="Last execution status"
    )
    nextExecutionTime: Optional[datetime] = Field(
        None, description="Next scheduled execution time"
    )
    webhookUrl: Optional[str] = Field(
        None, description="Webhook URL (for event-webhook flows)"
    )
    executionCount: int = Field(0, description="Total execution count")
    successCount: int = Field(0, description="Successful execution count")
    failureCount: int = Field(0, description="Failed execution count")


class FlowMetadata(BaseModel):
    """Flow CRD metadata."""

    name: str
    namespace: str = "default"
    displayName: Optional[str] = None
    labels: Optional[Dict[str, str]] = None


class Flow(BaseModel):
    """Flow CRD."""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Flow"
    metadata: FlowMetadata
    spec: FlowSpec
    status: Optional[FlowStatus] = None


class FlowList(BaseModel):
    """Flow list."""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "FlowList"
    items: List[Flow]


# API Request/Response schemas
class FlowBase(BaseModel):
    """Base Flow model for API."""

    name: str = Field(..., description="Flow unique identifier")
    display_name: str = Field(..., description="Display name")
    description: Optional[str] = Field(None, description="Flow description")
    task_type: FlowTaskType = Field(
        FlowTaskType.COLLECTION, description="Task type"
    )
    trigger_type: FlowTriggerType = Field(..., description="Trigger type")
    trigger_config: Dict[str, Any] = Field(..., description="Trigger configuration")
    team_id: int = Field(..., description="Team (Agent) ID")
    workspace_id: Optional[int] = Field(None, description="Workspace ID (optional)")
    prompt_template: str = Field(..., description="Prompt template")
    retry_count: int = Field(0, ge=0, le=3, description="Retry count (0-3)")
    enabled: bool = Field(True, description="Whether enabled")


class FlowCreate(FlowBase):
    """Flow creation model."""

    namespace: str = Field("default", description="Namespace")


class FlowUpdate(BaseModel):
    """Flow update model."""

    display_name: Optional[str] = None
    description: Optional[str] = None
    task_type: Optional[FlowTaskType] = None
    trigger_type: Optional[FlowTriggerType] = None
    trigger_config: Optional[Dict[str, Any]] = None
    team_id: Optional[int] = None
    workspace_id: Optional[int] = None
    prompt_template: Optional[str] = None
    retry_count: Optional[int] = Field(None, ge=0, le=3)
    enabled: Optional[bool] = None


class FlowInDB(FlowBase):
    """Database Flow model."""

    id: int
    user_id: int
    namespace: str = "default"
    webhook_url: Optional[str] = None
    last_execution_time: Optional[datetime] = None
    last_execution_status: Optional[str] = None
    next_execution_time: Optional[datetime] = None
    execution_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FlowListResponse(BaseModel):
    """Flow list response."""

    total: int
    items: List[FlowInDB]


# Flow Execution schemas
class FlowExecutionBase(BaseModel):
    """Base Flow Execution model."""

    flow_id: int
    trigger_type: str = Field(..., description="What triggered this execution")
    trigger_reason: Optional[str] = Field(None, description="Human-readable trigger reason")
    prompt: str = Field(..., description="Resolved prompt (with variables substituted)")


class FlowExecutionCreate(FlowExecutionBase):
    """Flow Execution creation model."""

    task_id: Optional[int] = Field(None, description="Associated Task ID")


class FlowExecutionInDB(FlowExecutionBase):
    """Database Flow Execution model."""

    id: int
    user_id: int
    task_id: Optional[int] = None
    status: FlowExecutionStatus = FlowExecutionStatus.PENDING
    result_summary: Optional[str] = None
    error_message: Optional[str] = None
    retry_attempt: int = 0
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    # Joined fields for display
    flow_name: Optional[str] = None
    flow_display_name: Optional[str] = None
    team_name: Optional[str] = None
    task_type: Optional[str] = None

    class Config:
        from_attributes = True


class FlowExecutionDetail(FlowExecutionInDB):
    """Detailed Flow Execution with task info."""

    task_detail: Optional[Dict[str, Any]] = None


class FlowExecutionListResponse(BaseModel):
    """Flow Execution list response (timeline)."""

    total: int
    items: List[FlowExecutionInDB]


# Timeline filter schemas
class FlowTimelineFilter(BaseModel):
    """Filter options for flow timeline."""

    time_range: Optional[str] = Field(
        "7d", description="Time range: 'today', '7d', '30d', 'custom'"
    )
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    status: Optional[List[FlowExecutionStatus]] = None
    flow_ids: Optional[List[int]] = None
    team_ids: Optional[List[int]] = None
    task_types: Optional[List[FlowTaskType]] = None
