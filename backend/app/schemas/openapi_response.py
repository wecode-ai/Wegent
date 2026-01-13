# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI Response schemas for v1/responses endpoint.
Compatible with OpenAI Responses API format.
"""

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field


class WegentTool(BaseModel):
    """Custom Wegent tool configuration.

    Supported tool types:
    - wegent_chat_bot: Enable all server-side capabilities (recommended)
      Includes: deep thinking with web search, server MCP tools, and message enhancement
    - mcp: Custom MCP server configuration
      Allows connecting to user-provided MCP servers for additional tools
    - skill: Preload specific skills for the bot

    Note:
    - Bot/Ghost MCP tools are always available by default (no user tool needed)
    - Use wegent_chat_bot to enable full server-side capabilities
    - Use mcp type with mcp_servers to add custom MCP servers
    - Use skill type with skills to preload specific skills

    Examples:
        # Enable all server-side capabilities
        {"type": "wegent_chat_bot"}

        # Add custom MCP servers (standard format)
        {
            "type": "mcp",
            "mcp_servers": [
                {
                    "my-server": {"url": "http://...", "type": "http"},
                    "another": {"url": "http://...", "type": "sse"}
                }
            ]
        }

        # Preload specific skills
        {"type": "skill", "preload_skills": ["skill_a", "skill_b"]}
    """

    type: str = Field(
        ...,
        description="Tool type: 'wegent_chat_bot' (server capabilities), 'mcp' (custom MCP servers), or 'skill' (preload skills)",
    )
    mcp_servers: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description="List containing a dict of MCP server configs: [{name: {url, type, headers}, ...}]. Required when type='mcp'",
    )
    preload_skills: Optional[List[str]] = Field(
        default=None,
        description="List of skill names to preload. Required when type='skill'",
    )


class InputTextContent(BaseModel):
    """Text content in input message."""

    type: Literal["input_text", "output_text"] = "input_text"
    text: str


class InputItem(BaseModel):
    """Input item for conversation history."""

    type: Literal["message"] = "message"
    role: Literal["user", "assistant"]
    content: Union[str, List[InputTextContent]]


class ResponseCreateInput(BaseModel):
    """Request schema for creating a response."""

    model: str = Field(
        ..., description="Format: namespace#team_name or namespace#team_name#model_id"
    )
    input: Union[str, List[InputItem]] = Field(
        ..., description="User input prompt or conversation history"
    )
    previous_response_id: Optional[str] = Field(
        default=None, description="Previous response ID for follow-up"
    )
    stream: bool = Field(
        default=False, description="Whether to enable streaming output"
    )
    tools: Optional[List[WegentTool]] = Field(
        default=None,
        description="Wegent custom tools: [{'type': 'wegent_chat_bot'}] to enable all server-side capabilities",
    )


class OutputTextContent(BaseModel):
    """Text content in output message."""

    type: Literal["output_text"] = "output_text"
    text: str
    annotations: List[Any] = Field(default_factory=list)


class OutputMessage(BaseModel):
    """Output message from the model."""

    type: Literal["message"] = "message"
    id: str  # Format: msg_{subtask_id}
    status: Literal["in_progress", "completed", "incomplete"]
    role: Literal["assistant", "user"]
    content: List[OutputTextContent]


class ResponseError(BaseModel):
    """Error information when response fails."""

    code: str
    message: str


class ResponseObject(BaseModel):
    """Response object compatible with OpenAI Responses API."""

    id: str  # Format: resp_{task_id}
    object: Literal["response"] = "response"
    created_at: int  # Unix timestamp
    status: Literal[
        "completed", "failed", "in_progress", "cancelled", "queued", "incomplete"
    ]
    error: Optional[ResponseError] = None
    model: str  # The model string from request
    output: List[OutputMessage] = Field(default_factory=list)
    previous_response_id: Optional[str] = None


class ResponseDeletedObject(BaseModel):
    """Response object for delete operation."""

    id: str
    object: Literal["response"] = "response"
    deleted: bool = True


# ============================================================
# Streaming Event Schemas (OpenAI v1/responses SSE format)
# ============================================================


class StreamingResponseCreated(BaseModel):
    """Event when response is created."""

    type: Literal["response.created"] = "response.created"
    response: ResponseObject


class StreamingOutputItemAdded(BaseModel):
    """Event when output item is added."""

    type: Literal["response.output_item.added"] = "response.output_item.added"
    output_index: int
    item: dict  # Contains type, role, content (empty)


class StreamingContentPartAdded(BaseModel):
    """Event when content part is added."""

    type: Literal["response.content_part.added"] = "response.content_part.added"
    output_index: int
    content_index: int
    part: dict  # Contains type and text (empty)


class StreamingOutputTextDelta(BaseModel):
    """Event for text delta."""

    type: Literal["response.output_text.delta"] = "response.output_text.delta"
    output_index: int
    content_index: int
    delta: str


class StreamingOutputTextDone(BaseModel):
    """Event when text output is done."""

    type: Literal["response.output_text.done"] = "response.output_text.done"
    output_index: int
    content_index: int
    text: str


class StreamingContentPartDone(BaseModel):
    """Event when content part is done."""

    type: Literal["response.content_part.done"] = "response.content_part.done"
    output_index: int
    content_index: int
    part: dict


class StreamingOutputItemDone(BaseModel):
    """Event when output item is done."""

    type: Literal["response.output_item.done"] = "response.output_item.done"
    output_index: int
    item: dict


class StreamingResponseCompleted(BaseModel):
    """Event when response is completed."""

    type: Literal["response.completed"] = "response.completed"
    response: ResponseObject


class StreamingResponseFailed(BaseModel):
    """Event when response fails."""

    type: Literal["response.failed"] = "response.failed"
    response: ResponseObject
