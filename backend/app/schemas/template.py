# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Template CRD schemas for preset resource bundles.

Templates define complete resource configurations that can be instantiated
by users to create full workflows (e.g., Inbox automation).
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# --- Template resource sub-configs ---


class TemplateResourceGhostConfig(BaseModel):
    """Ghost resource configuration within a template."""

    systemPrompt: str = Field(..., description="System prompt for the Ghost")
    mcpServers: Optional[Dict[str, Any]] = Field(
        None, description="MCP server configurations"
    )
    skills: Optional[List[str]] = Field(None, description="Skill names to attach")


class TemplateResourceBotConfig(BaseModel):
    """Bot resource configuration within a template."""

    shellName: str = Field(
        "Chat", description="Shell name to reference (e.g., Chat, ClaudeCode)"
    )
    agentConfig: Optional[Dict[str, Any]] = Field(
        None, description="Agent/model config (bind_model etc.)"
    )


class TemplateResourceTeamConfig(BaseModel):
    """Team resource configuration within a template."""

    collaborationModel: str = Field("pipeline", description="Team collaboration model")
    bindMode: Optional[List[str]] = Field(None, description="Bind mode (chat/code)")
    description: Optional[str] = Field(None, description="Team description")


class TemplateResourceSubscriptionConfig(BaseModel):
    """Subscription resource configuration within a template."""

    promptTemplate: str = Field(
        ..., description="Prompt template for inbox message processing"
    )
    retryCount: int = Field(1, ge=0, le=3, description="Retry count on failure")
    timeoutSeconds: int = Field(
        600, ge=60, le=3600, description="Execution timeout in seconds"
    )


class TemplateResourceQueueConfig(BaseModel):
    """Work queue resource configuration within a template."""

    visibility: str = Field("private", description="Queue visibility")
    triggerMode: str = Field("immediate", description="Auto-process trigger mode")


class TemplateResources(BaseModel):
    """Complete resource bundle for a template."""

    ghost: TemplateResourceGhostConfig
    bot: TemplateResourceBotConfig
    team: TemplateResourceTeamConfig = Field(default_factory=TemplateResourceTeamConfig)
    subscription: TemplateResourceSubscriptionConfig
    queue: TemplateResourceQueueConfig = Field(
        default_factory=TemplateResourceQueueConfig
    )


# --- Template API schemas ---


class TemplateCreate(BaseModel):
    """Request model for creating a template (admin only)."""

    name: str = Field(
        ..., min_length=1, max_length=100, description="Template unique name"
    )
    displayName: str = Field(
        ..., min_length=1, max_length=100, description="Display name"
    )
    description: Optional[str] = Field(
        None, max_length=500, description="Template description"
    )
    category: str = Field("inbox", description="Template category")
    tags: List[str] = Field(default_factory=list, description="Tags for filtering")
    icon: Optional[str] = Field(None, description="Template icon (emoji or URL)")
    resources: TemplateResources


class TemplateUpdate(BaseModel):
    """Request model for updating a template (admin only)."""

    displayName: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    category: Optional[str] = None
    tags: Optional[List[str]] = None
    icon: Optional[str] = None
    resources: Optional[TemplateResources] = None


class TemplateResponse(BaseModel):
    """Response model for a template."""

    id: int
    name: str
    displayName: str
    description: Optional[str] = None
    category: str
    tags: List[str] = []
    icon: Optional[str] = None
    resources: TemplateResources
    createdAt: datetime
    updatedAt: datetime

    class Config:
        from_attributes = True


class TemplateListResponse(BaseModel):
    """Response model for template list."""

    total: int
    items: List[TemplateResponse]


class TemplateInstantiateResponse(BaseModel):
    """Response model for template instantiation."""

    ghostId: int
    botId: int
    teamId: int
    subscriptionId: int
    queueId: int
    queueName: str
