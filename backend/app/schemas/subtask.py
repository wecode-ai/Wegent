# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

# Import the masking utility - using relative import from backend
import sys
from datetime import datetime
from enum import Enum
from typing import Any, List, Optional

from pydantic import BaseModel, Field, field_serializer

# Add the project root to sys.path if not already there
project_root = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from shared.utils.sensitive_data_masker import mask_sensitive_data


class SubtaskStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    DELETE = "DELETE"
    PENDING_CONFIRMATION = "PENDING_CONFIRMATION"  # Pipeline stage completed, waiting for user confirmation


class SubtaskRole(str, Enum):
    USER = "USER"
    ASSISTANT = "ASSISTANT"


class SenderType(str, Enum):
    """Sender type for group chat messages"""

    USER = "USER"  # Message sent by a user
    TEAM = "TEAM"  # Message sent by the AI team/agent
    SYSTEM = "SYSTEM"  # System notification message (e.g., KB binding)


class SubtaskBase(BaseModel):
    """Subtask base model"""

    task_id: int
    team_id: int
    title: str
    bot_ids: List[int] = []
    role: SubtaskRole = SubtaskRole.ASSISTANT
    prompt: Optional[str] = None
    executor_namespace: Optional[str] = None
    executor_name: Optional[str] = None
    message_id: int = 0
    parent_id: Optional[int] = None
    status: SubtaskStatus = SubtaskStatus.PENDING
    progress: int = 0
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None


class SubtaskCreate(SubtaskBase):
    """Subtask creation model"""

    pass


class SubtaskAttachment(BaseModel):
    """
    Subtask attachment schema.

    DEPRECATED: This schema is deprecated and will be removed in a future version.
    Use SubtaskContextBrief instead for unified context management.

    Migration: Replace all usage with SubtaskContextBrief which supports
    both attachments and knowledge base contexts.
    """

    id: int
    filename: str = Field(validation_alias="original_filename")
    file_size: int
    mime_type: str
    status: str
    file_extension: str
    created_at: datetime

    class Config:
        from_attributes = True
        populate_by_name = True


class SubtaskContextBrief(BaseModel):
    """Brief context info for message list display"""

    id: int
    context_type: str
    name: str
    status: str
    # Attachment fields (from type_data)
    file_extension: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None
    # Knowledge base fields (from type_data)
    document_count: Optional[int] = None
    # Table fields (from type_data) - nested structure to match frontend expectation
    source_config: Optional[dict[str, Any]] = None

    class Config:
        from_attributes = True

    @classmethod
    def from_model(cls, context) -> "SubtaskContextBrief":
        """
        Create brief from SubtaskContext model.
        Only includes type-specific fields based on context_type.
        """
        type_data = context.type_data or {}

        # Base fields for all context types
        base_data = {
            "id": context.id,
            "context_type": context.context_type,
            "name": context.name,
            "status": (
                context.status
                if isinstance(context.status, str)
                else context.status.value
            ),
        }

        # Add type-specific fields
        if context.context_type == "attachment":
            base_data.update(
                {
                    "file_extension": type_data.get("file_extension"),
                    "file_size": type_data.get("file_size"),
                    "mime_type": type_data.get("mime_type"),
                }
            )
        elif context.context_type == "knowledge_base":
            base_data.update(
                {
                    "document_count": type_data.get("document_count"),
                }
            )
        elif context.context_type == "table":
            # Build source_config for table contexts
            url = type_data.get("url")
            if url:
                base_data["source_config"] = {"url": url}
                # DEBUG: Log table context creation
                import logging

                logger = logging.getLogger(__name__)
                logger.info(
                    f"[SubtaskContextBrief/subtask.py] Building table context: id={context.id}, "
                    f"url={url}, source_config={base_data['source_config']}"
                )

        return cls(**base_data)


class SubtaskUpdate(BaseModel):
    """Subtask update model"""

    title: Optional[str] = None
    status: Optional[SubtaskStatus] = None
    progress: Optional[int] = None
    executor_namespace: Optional[str] = None
    executor_name: Optional[str] = None
    message_id: Optional[int] = None
    parent_id: Optional[int] = None
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None
    executor_deleted_at: Optional[bool] = False


class SubtaskInDB(SubtaskBase):
    """Database subtask model"""

    id: int
    user_id: int
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime] = None
    executor_deleted_at: Optional[bool] = False
    # Contexts replace attachments for unified context management
    contexts: List[SubtaskContextBrief] = []
    # DEPRECATED: Backward compatibility field (derived from contexts)
    # This field is populated from contexts where context_type='attachment'
    # Use 'contexts' field instead for new code
    attachments: List[SubtaskAttachment] = []
    # Group chat fields
    sender_type: Optional[SenderType] = None  # USER or TEAM
    sender_user_id: Optional[int] = None  # User ID when sender_type=USER
    sender_user_name: Optional[str] = None  # User name for display
    reply_to_subtask_id: Optional[int] = None  # Quoted message ID

    @field_serializer("contexts")
    def serialize_contexts(self, value: List) -> List[dict[str, Any]]:
        """Convert ORM context models to properly constructed Pydantic models"""
        if not value:
            return []

        result = []
        for ctx in value:
            # Check if it's already a Pydantic model (has model_dump method)
            if hasattr(ctx, "model_dump"):
                result.append(ctx.model_dump(mode="json"))
            else:
                # It's an ORM model, convert using from_model
                brief = SubtaskContextBrief.from_model(ctx)
                result.append(brief.model_dump(mode="json"))

        return result

    @field_serializer("result")
    def mask_result(self, value: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
        """Mask sensitive data in result field before serialization"""
        if value is None:
            return None
        return mask_sensitive_data(value)

    @field_serializer("error_message")
    def mask_error_message(self, value: Optional[str]) -> Optional[str]:
        """Mask sensitive data in error_message field before serialization"""
        if value is None:
            return None
        return mask_sensitive_data(value)

    class Config:
        from_attributes = True


class SubtaskWithBot(SubtaskInDB):
    """Subtask model with bot object instead of bot_id"""

    bot: Optional[dict] = (
        None  # Using dict instead of Bot schema to avoid circular imports
    )

    class Config:
        from_attributes = True


class SubtaskWithSender(SubtaskInDB):
    """Subtask model with sender username"""

    sender_username: Optional[str] = None  # Username of the sender (for group chat)

    class Config:
        from_attributes = True


class SubtaskListResponse(BaseModel):
    """Subtask paginated response model"""

    total: int
    items: list[SubtaskInDB]


class PollMessagesResponse(BaseModel):
    """Response model for polling new messages"""

    messages: List[SubtaskWithSender]
    has_streaming: bool = False  # Whether there's an active stream
    streaming_subtask_id: Optional[int] = None  # ID of the streaming subtask


class StreamingStatus(BaseModel):
    """Response model for streaming status"""

    is_streaming: bool
    subtask_id: Optional[int] = None
    started_by_user_id: Optional[int] = None
    started_by_username: Optional[str] = None
    current_content: Optional[str] = None
    started_at: Optional[datetime] = None


class SubtaskExecutorUpdate(BaseModel):
    """Executor subtask update model"""

    subtask_id: int
    task_title: Optional[str] = None
    subtask_title: Optional[str] = None
    status: SubtaskStatus
    progress: int = 0
    executor_namespace: Optional[str] = None
    executor_name: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None


class MessageEditRequest(BaseModel):
    """Request model for editing a user message"""

    new_content: str = Field(..., min_length=1, description="New message content")


class MessageEditResponse(BaseModel):
    """Response model for message edit operation"""

    success: bool = True
    subtask_id: int
    message_id: int
    deleted_count: int = Field(description="Number of subsequent messages deleted")
    new_content: str = Field(description="The updated message content")
