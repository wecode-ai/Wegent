# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI Response schemas for v1/responses endpoint.
Compatible with OpenAI Responses API format.
"""

from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field


class ResponseCreateInput(BaseModel):
    """Request schema for creating a response."""

    model: str = Field(
        ..., description="Format: namespace#team_name or namespace#team_name#model_id"
    )
    input: str = Field(..., description="User input prompt")
    previous_response_id: Optional[str] = Field(
        default=None, description="Previous response ID for follow-up"
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
    role: Literal["assistant"] = "assistant"
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
