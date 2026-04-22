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


class TemplateResourceSkillRef(BaseModel):
    """Precise skill reference for template-defined Ghost skills."""

    name: str = Field(..., description="Skill name")
    namespace: str = Field("default", description="Skill namespace")
    userId: int = Field(
        ..., description="Skill owner user_id. Use 0 for public/system skills"
    )


class TemplateResourceGhostConfig(BaseModel):
    """Ghost resource configuration within a template."""

    systemPrompt: str = Field(..., description="System prompt for the Ghost")
    mcpServers: Optional[Dict[str, Any]] = Field(
        None, description="MCP server configurations"
    )
    skills: Optional[List[str]] = Field(None, description="Skill names to attach")
    skillRefs: Optional[List[TemplateResourceSkillRef]] = Field(
        None,
        description=(
            "Precise skill references using name + namespace + userId. "
            "Use this to avoid ambiguous skill resolution."
        ),
    )


class TemplateResourceBotConfig(BaseModel):
    """Bot resource configuration within a template."""

    shellName: str = Field(
        "Chat", description="Shell name to reference (e.g., Chat, ClaudeCode)"
    )
    agentConfig: Optional[Dict[str, Any]] = Field(
        None,
        description=(
            "Predefined model binding config using bind_model, "
            "bind_model_type, and bind_model_namespace"
        ),
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


class TemplateResourceTeamRef(BaseModel):
    """Reference to an existing Team resource (e.g. a system public Team)."""

    name: str = Field(..., description="Team name")
    namespace: str = Field("default", description="Team namespace")


class TemplateResourceQueueConfig(BaseModel):
    """Work queue resource configuration within a template.

    Auto-process mode is determined automatically:
    - If the template defines a 'subscription' resource: mode='subscription'
    - If 'teamRef' is set (pointing to an existing Team): mode='direct_agent'
    - Otherwise: mode='direct_agent' using the Team created by this template
    """

    visibility: str = Field("private", description="Queue visibility")
    triggerMode: str = Field("immediate", description="Auto-process trigger mode")
    teamRef: Optional[TemplateResourceTeamRef] = Field(
        None,
        description=(
            "Reference to an existing Team for direct_agent mode. "
            "When set, no Ghost/Bot/Team resources need to be defined in the template."
        ),
    )


class TemplateResources(BaseModel):
    """Resource bundle for a template.

    All resource types are optional - only defined resources are created.
    The instantiation engine creates resources in dependency order and
    resolves cross-references automatically.

    Minimal template (direct chat to existing team):
      queue:
        teamRef: {name: wegent-chat, namespace: default}

    Full inbox automation template:
      ghost: {systemPrompt: ...}
      bot: {shellName: Chat}
      team: {collaborationModel: pipeline}
      subscription: {promptTemplate: ..., retryCount: 1}
      queue: {visibility: private}
    """

    ghost: Optional[TemplateResourceGhostConfig] = None
    bot: Optional[TemplateResourceBotConfig] = None
    team: Optional[TemplateResourceTeamConfig] = None
    subscription: Optional[TemplateResourceSubscriptionConfig] = None
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
    """Response model for template instantiation.

    For 'inbox' category templates: ghostId, botId, teamId, subscriptionId, queueId are set.
    For 'direct_agent' mode queues: subscriptionId is None.
    For 'direct_chat' category templates: only queueId and queueName are set.
    """

    ghostId: Optional[int] = None
    botId: Optional[int] = None
    teamId: Optional[int] = None
    subscriptionId: Optional[int] = None
    queueId: int
    queueName: str
