# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for REST-created device chat tasks."""

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.api.ws.events import ContextItem, GenerateParams, SkillRef
from app.core.constants import CLIENT_ORIGIN_FRONTEND, SUPPORTED_CLIENT_ORIGINS


class DeviceChatTaskRequest(BaseModel):
    """Create a new device chat task or append a message to an existing task."""

    model_config = ConfigDict(populate_by_name=True)

    team_id: int = Field(..., alias="teamId", description="Team ID to run")
    message: str = Field(..., min_length=1, description="User message content")
    task_id: Optional[int] = Field(
        default=None,
        alias="taskId",
        description="Existing task ID. Omit to create a new device chat task.",
    )
    device_id: Optional[str] = Field(
        default=None,
        alias="deviceId",
        description="Local device ID. Omit to use task/project/default resolution.",
    )
    title: Optional[str] = Field(
        default=None,
        description="Custom title for new tasks",
    )
    model_id: Optional[str] = Field(
        default=None,
        alias="modelId",
        description="Override model ID",
    )
    model_type: Optional[str] = Field(
        default=None,
        alias="modelType",
        description="Override model type, such as public/user/group/runtime",
    )
    model_options: Optional[dict[str, Any]] = Field(
        default=None,
        alias="modelOptions",
        description="Model selection options such as reasoning or speed.",
    )
    project_id: Optional[int] = Field(
        default=None,
        alias="projectId",
        description="Optional project ID to associate with new tasks.",
    )
    task_type: Literal["task"] = Field(
        default="task",
        alias="taskType",
        description="Device chat tasks use the task surface.",
    )
    attachment_ids: Optional[list[int]] = Field(
        default=None,
        alias="attachmentIds",
        description="Optional attachment IDs to link to the user message.",
    )
    contexts: Optional[list[ContextItem]] = Field(
        default=None,
        description="Optional context items for the message.",
    )
    additional_skills: Optional[list[SkillRef]] = Field(
        default=None,
        alias="additionalSkills",
        description="Additional skills selected for this task.",
    )
    enable_deep_thinking: bool = Field(
        default=True,
        alias="enableDeepThinking",
        description="Enable deep thinking/tool usage.",
    )
    enable_web_search: bool = Field(
        default=False,
        alias="enableWebSearch",
        description="Enable web search.",
    )
    search_engine: Optional[str] = Field(
        default=None,
        alias="searchEngine",
        description="Search engine to use when web search is enabled.",
    )
    enable_clarification: bool = Field(
        default=False,
        alias="enableClarification",
        description="Enable clarification mode.",
    )
    client_origin: str = Field(
        default=CLIENT_ORIGIN_FRONTEND,
        alias="clientOrigin",
        pattern=f"^({'|'.join(SUPPORTED_CLIENT_ORIGINS)})$",
        description="Client surface that owns the task.",
    )
    generate_params: Optional[GenerateParams] = Field(
        default=None,
        alias="generateParams",
        description="Video/image generation parameters when applicable.",
    )


class DeviceChatTaskResponse(BaseModel):
    """Response for a REST-created device chat task message."""

    model_config = ConfigDict(populate_by_name=True)

    task_id: int = Field(..., alias="taskId")
    user_subtask_id: int = Field(..., alias="userSubtaskId")
    assistant_subtask_id: Optional[int] = Field(
        default=None,
        alias="assistantSubtaskId",
    )
    message_id: int = Field(..., alias="messageId")
    ai_triggered: bool = Field(..., alias="aiTriggered")
    device_id: Optional[str] = Field(default=None, alias="deviceId")
    chat_url: str = Field(..., alias="chatUrl")
