# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Work Queue API schemas."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator


# Re-export enums for API use
class QueueVisibility(str, Enum):
    """Work queue visibility levels."""

    PRIVATE = "private"
    PUBLIC = "public"
    GROUP_VISIBLE = "group_visible"
    INVITE_ONLY = "invite_only"


class QueueMessageStatus(str, Enum):
    """Queue message processing status."""

    UNREAD = "unread"
    READ = "read"
    PROCESSING = "processing"
    PROCESSED = "processed"
    ARCHIVED = "archived"
    FAILED = "failed"


class QueueMessagePriority(str, Enum):
    """Queue message priority levels."""

    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"


class TriggerMode(str, Enum):
    """Auto-processing trigger mode."""

    IMMEDIATE = "immediate"
    MANUAL = "manual"
    SCHEDULED = "scheduled"
    CONDITION_BASED = "condition_based"


class ConditionAction(str, Enum):
    """Condition-based trigger action."""

    IMMEDIATE = "immediate"
    SKIP = "skip"


class ConditionType(str, Enum):
    """Condition type for auto-processing."""

    PRIORITY_HIGH = "priority_high"
    SPECIFIC_SENDER = "specific_sender"


# WorkQueue CRD schemas (stored in kinds table)
class TeamRef(BaseModel):
    """Reference to a Team for auto-processing."""

    namespace: str = "default"
    name: str


class SubscriptionRef(BaseModel):
    """Reference to a Subscription for auto-processing."""

    namespace: str = "default"
    name: str
    userId: int


class ProcessCondition(BaseModel):
    """Condition rule for auto-processing."""

    type: ConditionType
    value: Optional[str] = None  # e.g., sender user_id for SPECIFIC_SENDER
    action: ConditionAction


class AutoProcessConfig(BaseModel):
    """Auto-processing configuration."""

    enabled: bool = False
    teamRef: Optional[TeamRef] = None
    subscriptionRef: Optional[SubscriptionRef] = None
    triggerMode: TriggerMode = TriggerMode.MANUAL
    scheduleInterval: Optional[int] = Field(
        None, ge=15, description="Schedule interval in minutes (min: 15)"
    )
    conditions: Optional[List[ProcessCondition]] = None


class ResultFeedbackConfig(BaseModel):
    """Result feedback configuration."""

    replyToSender: bool = False
    saveInQueue: bool = True
    sendNotification: bool = False


class WorkQueueSpec(BaseModel):
    """WorkQueue CRD specification."""

    displayName: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    isDefault: bool = False
    visibility: QueueVisibility = QueueVisibility.PRIVATE
    visibleToGroups: Optional[List[str]] = None
    inviteCode: Optional[str] = None
    autoProcess: Optional[AutoProcessConfig] = None
    resultFeedback: Optional[ResultFeedbackConfig] = None


class WorkQueueMetadata(BaseModel):
    """WorkQueue CRD metadata."""

    name: str
    namespace: str = "default"
    displayName: Optional[str] = None


class WorkQueueStatus(BaseModel):
    """WorkQueue CRD status."""

    state: str = "Available"
    messageCount: int = 0
    unreadCount: int = 0


class WorkQueue(BaseModel):
    """WorkQueue CRD."""

    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "WorkQueue"
    metadata: WorkQueueMetadata
    spec: WorkQueueSpec
    status: Optional[WorkQueueStatus] = None


class WorkQueueCreate(BaseModel):
    """Request model for creating a work queue."""

    name: str = Field(..., min_length=1, max_length=100)
    displayName: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    visibility: QueueVisibility = QueueVisibility.PRIVATE
    visibleToGroups: Optional[List[str]] = None
    autoProcess: Optional[AutoProcessConfig] = None
    resultFeedback: Optional[ResultFeedbackConfig] = None


class WorkQueueUpdate(BaseModel):
    """Request model for updating a work queue."""

    displayName: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    visibility: Optional[QueueVisibility] = None
    visibleToGroups: Optional[List[str]] = None
    autoProcess: Optional[AutoProcessConfig] = None
    resultFeedback: Optional[ResultFeedbackConfig] = None


class WorkQueueResponse(BaseModel):
    """Response model for work queue."""

    id: int
    name: str
    displayName: str
    description: Optional[str] = None
    isDefault: bool = False
    visibility: QueueVisibility
    visibleToGroups: Optional[List[str]] = None
    inviteCode: Optional[str] = None
    autoProcess: Optional[AutoProcessConfig] = None
    resultFeedback: Optional[ResultFeedbackConfig] = None
    messageCount: int = 0
    unreadCount: int = 0
    createdAt: datetime
    updatedAt: datetime


class WorkQueueListResponse(BaseModel):
    """Response model for work queue list."""

    items: List[WorkQueueResponse]
    total: int


# Queue Message schemas
class MessageContentSnapshot(BaseModel):
    """Snapshot of message content."""

    role: str  # USER or ASSISTANT
    content: str
    senderUserName: Optional[str] = None
    createdAt: Optional[str] = None
    attachments: Optional[List[Dict[str, Any]]] = None
    # IDs of subtask_contexts records pre-written from uploaded files/content.
    # Stored on the USER message that owns the attachments so that
    # _link_inbox_attachments_to_subtask() can retrieve them without a
    # separate DB column.
    attachmentContextIds: Optional[List[int]] = None


class QueueMessageCreate(BaseModel):
    """Internal model for creating a queue message."""

    queue_id: int
    sender_user_id: int
    recipient_user_id: int
    source_task_id: int
    source_subtask_ids: List[int]
    content_snapshot: List[MessageContentSnapshot]
    note: Optional[str] = None
    priority: QueueMessagePriority = QueueMessagePriority.NORMAL


class SenderInfo(BaseModel):
    """Sender information for queue message."""

    id: int
    userName: str
    email: Optional[str] = None


class QueueMessageResponse(BaseModel):
    """Response model for queue message."""

    id: int
    queueId: int
    sender: SenderInfo
    sourceTaskId: int
    sourceSubtaskIds: List[int]
    contentSnapshot: List[MessageContentSnapshot]
    note: str = ""
    priority: QueueMessagePriority
    status: QueueMessageStatus
    processResult: Dict[str, Any] = Field(default_factory=dict)
    processTaskId: int = 0
    processSubscriptionId: Optional[int] = None
    retryCount: int = 0
    createdAt: datetime
    updatedAt: datetime
    processedAt: datetime

    class Config:
        from_attributes = True


class QueueMessageListResponse(BaseModel):
    """Response model for queue message list."""

    items: List[QueueMessageResponse]
    total: int
    unreadCount: int


class QueueMessageStatusUpdate(BaseModel):
    """Request model for updating queue message status."""

    status: QueueMessageStatus


class QueueMessagePriorityUpdate(BaseModel):
    """Request model for updating queue message priority."""

    priority: QueueMessagePriority


# Batch operation schemas
class BatchMessageIds(BaseModel):
    """Request model for batch message operations."""

    messageIds: List[int] = Field(..., min_length=1, max_length=100)


class BatchStatusUpdate(BaseModel):
    """Request model for batch updating message status."""

    messageIds: List[int] = Field(..., min_length=1, max_length=100)
    status: QueueMessageStatus


class BatchOperationResult(BaseModel):
    """Response model for batch operations."""

    successCount: int
    failedCount: int
    failedIds: List[int] = Field(default_factory=list)


# Message forwarding schemas
class ForwardRecipient(BaseModel):
    """Recipient for message forwarding."""

    type: str = Field(..., description="'user' or 'group'")
    id: int = Field(..., description="User ID or Group ID")
    queueId: Optional[int] = Field(
        None, description="Queue ID (uses default if not specified)"
    )


class ForwardMessageRequest(BaseModel):
    """Request model for forwarding messages."""

    sourceTaskId: int
    subtaskIds: Optional[List[int]] = Field(
        None, description="Message IDs to forward (empty = entire conversation)"
    )
    recipients: List[ForwardRecipient]
    note: Optional[str] = Field(None, max_length=1000)
    priority: QueueMessagePriority = QueueMessagePriority.NORMAL


class ForwardMessageResponse(BaseModel):
    """Response model for message forwarding."""

    success: bool
    forwardedCount: int
    failedRecipients: Optional[List[Dict[str, Any]]] = None


# Recent contacts schemas
class RecentContactResponse(BaseModel):
    """Response model for recent contact."""

    id: int
    userId: int
    userName: str
    email: Optional[str] = None
    lastContactAt: datetime
    contactCount: int

    class Config:
        from_attributes = True


class RecentContactsListResponse(BaseModel):
    """Response model for recent contacts list."""

    items: List[RecentContactResponse]
    total: int


# User public queue schemas
class PublicQueueResponse(BaseModel):
    """Response model for public queue (for forwarding)."""

    id: int
    name: str
    displayName: str
    description: Optional[str] = None
    isDefault: bool


class UserPublicQueuesResponse(BaseModel):
    """Response model for user's public queues."""

    userId: int
    userName: str
    queues: List[PublicQueueResponse]


# Unread count schema
class UnreadCountResponse(BaseModel):
    """Response model for unread message count."""

    total: int
    byQueue: Dict[int, int] = Field(
        default_factory=dict, description="Unread count by queue ID"
    )


class ExternalSender(BaseModel):
    """External sender information for ingest API."""

    externalId: Optional[str] = None
    displayName: Optional[str] = None


class IngestSource(BaseModel):
    """Source information for ingested messages."""

    type: str = "api"
    name: Optional[str] = None


class IngestMessageRequest(BaseModel):
    """Request model for ingesting messages into a queue.

    Either `content` or `attachmentContextIds` must be provided.
    When files are uploaded via the multipart endpoint, the caller
    pre-writes them to subtask_contexts and passes the resulting IDs
    in `attachmentContextIds`, allowing `content` to be omitted.
    """

    content: Optional[str] = Field(None, max_length=50000)
    title: Optional[str] = Field(None, max_length=200)
    note: Optional[str] = Field(None, max_length=1000)
    sender: Optional[ExternalSender] = None
    attachments: Optional[List[Dict[str, Any]]] = None
    # IDs of subtask_contexts records pre-written from uploaded files
    attachmentContextIds: Optional[List[int]] = None
    source: Optional[IngestSource] = None
    priority: QueueMessagePriority = QueueMessagePriority.NORMAL

    @model_validator(mode="after")
    def validate_content_or_attachments(self) -> "IngestMessageRequest":
        """Ensure at least one of content or attachmentContextIds is provided."""
        if not self.content and not self.attachmentContextIds:
            raise ValueError(
                "Either 'content' or 'attachmentContextIds' must be provided"
            )
        return self
