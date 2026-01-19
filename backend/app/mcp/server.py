# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Server for interactive messaging.

This module implements a built-in MCP Server that provides tools for
AI agents to send interactive messages to users.

The server is registered as FastAPI routes and can be accessed by
executors through HTTP or as built-in tools.
"""

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.mcp.context import TaskContextManager, get_task_context
from app.mcp.schemas.form import (
    FieldOption,
    FormField,
    SelectOption,
    SendConfirmInput,
    SendConfirmResult,
    SendFormInput,
    SendFormResult,
    SendSelectInput,
    SendSelectResult,
)
from app.mcp.schemas.message import (
    Attachment,
    SendMessageInput,
    SendMessageResult,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mcp/interactive", tags=["MCP Interactive"])


# ============================================================
# Tool Definitions for MCP Protocol
# ============================================================


class MCPToolDefinition(BaseModel):
    """MCP tool definition."""

    name: str
    description: str
    input_schema: Dict[str, Any]


class MCPToolsResponse(BaseModel):
    """Response containing available MCP tools."""

    tools: List[MCPToolDefinition]


class MCPToolCallRequest(BaseModel):
    """Request to call an MCP tool."""

    tool_name: str = Field(..., description="Name of the tool to call")
    arguments: Dict[str, Any] = Field(..., description="Tool arguments")
    task_id: int = Field(..., description="Task ID for context")
    subtask_id: int | None = Field(None, description="Optional subtask ID")


class MCPToolCallResponse(BaseModel):
    """Response from MCP tool call."""

    success: bool
    result: Dict[str, Any] | None = None
    error: str | None = None


# Tool definitions for MCP protocol
TOOL_DEFINITIONS: List[MCPToolDefinition] = [
    MCPToolDefinition(
        name="send_message",
        description="Send a message to the user. The message can be plain text or markdown format with optional attachments.",
        input_schema={
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "Message content (supports Markdown)",
                },
                "message_type": {
                    "type": "string",
                    "enum": ["text", "markdown"],
                    "default": "markdown",
                    "description": "Message type: text for plain text, markdown for rich text",
                },
                "attachments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "File name"},
                            "url": {"type": "string", "description": "File URL"},
                            "mime_type": {"type": "string", "description": "MIME type"},
                            "size": {"type": "integer", "description": "File size in bytes"},
                        },
                        "required": ["name", "url", "mime_type"],
                    },
                    "description": "Optional list of attachments",
                },
            },
            "required": ["content"],
        },
    ),
    MCPToolDefinition(
        name="send_form",
        description="Send an interactive form to the user. The user's response will be sent as a new message in the conversation.",
        input_schema={
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Form title"},
                "description": {"type": "string", "description": "Form description"},
                "fields": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "field_id": {"type": "string", "description": "Unique field ID"},
                            "field_type": {
                                "type": "string",
                                "enum": ["text", "textarea", "number", "single_choice", "multiple_choice", "datetime"],
                                "description": "Field type",
                            },
                            "label": {"type": "string", "description": "Field label"},
                            "placeholder": {"type": "string", "description": "Placeholder text"},
                            "default_value": {"description": "Default value"},
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "value": {"type": "string"},
                                        "label": {"type": "string"},
                                        "recommended": {"type": "boolean", "default": False},
                                    },
                                    "required": ["value", "label"],
                                },
                                "description": "Options for choice fields",
                            },
                            "validation": {
                                "type": "object",
                                "properties": {
                                    "required": {"type": "boolean"},
                                    "min_length": {"type": "integer"},
                                    "max_length": {"type": "integer"},
                                    "min": {"type": "number"},
                                    "max": {"type": "number"},
                                    "pattern": {"type": "string"},
                                    "pattern_message": {"type": "string"},
                                },
                            },
                        },
                        "required": ["field_id", "field_type", "label"],
                    },
                    "description": "Form field definitions",
                },
                "submit_button_text": {
                    "type": "string",
                    "default": "Submit",
                    "description": "Submit button text",
                },
            },
            "required": ["title", "fields"],
        },
    ),
    MCPToolDefinition(
        name="send_confirm",
        description="Send a confirmation dialog to the user. The user's choice (confirm/cancel) will be sent as a message.",
        input_schema={
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Dialog title"},
                "message": {"type": "string", "description": "Confirmation message (supports Markdown)"},
                "confirm_text": {"type": "string", "default": "Confirm", "description": "Confirm button text"},
                "cancel_text": {"type": "string", "default": "Cancel", "description": "Cancel button text"},
            },
            "required": ["title", "message"],
        },
    ),
    MCPToolDefinition(
        name="send_select",
        description="Send a selection dialog to the user. The user's selection will be sent as a message.",
        input_schema={
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Selection title"},
                "options": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "value": {"type": "string"},
                            "label": {"type": "string"},
                            "description": {"type": "string"},
                            "recommended": {"type": "boolean", "default": False},
                        },
                        "required": ["value", "label"],
                    },
                    "description": "Selection options",
                },
                "multiple": {"type": "boolean", "default": False, "description": "Allow multiple selection"},
                "description": {"type": "string", "description": "Optional description"},
            },
            "required": ["title", "options"],
        },
    ),
]


@router.get("/tools", response_model=MCPToolsResponse)
async def list_tools() -> MCPToolsResponse:
    """
    List available MCP tools.

    Returns the list of interactive messaging tools that can be called
    by AI agents.
    """
    return MCPToolsResponse(tools=TOOL_DEFINITIONS)


@router.post("/call", response_model=MCPToolCallResponse)
async def call_tool(request: MCPToolCallRequest) -> MCPToolCallResponse:
    """
    Call an MCP tool.

    This endpoint allows executors to call MCP tools with the specified
    arguments. The task_id is used to establish the context for the tool.
    """
    logger.info(
        f"[MCP] Tool call: tool={request.tool_name}, task_id={request.task_id}"
    )

    # Set up task context
    with TaskContextManager(
        task_id=request.task_id, subtask_id=request.subtask_id
    ):
        try:
            if request.tool_name == "send_message":
                from app.mcp.tools.send_message import send_message

                # Parse attachments if provided
                attachments = None
                if "attachments" in request.arguments and request.arguments["attachments"]:
                    attachments = [
                        Attachment(**att) for att in request.arguments["attachments"]
                    ]

                result = await send_message(
                    content=request.arguments.get("content", ""),
                    message_type=request.arguments.get("message_type", "markdown"),
                    attachments=attachments,
                )
                return MCPToolCallResponse(
                    success=result.success,
                    result=result.model_dump(),
                    error=result.error,
                )

            elif request.tool_name == "send_form":
                from app.mcp.tools.send_form import send_form

                # Parse fields
                fields = []
                for field_data in request.arguments.get("fields", []):
                    # Parse options if present
                    options = None
                    if "options" in field_data and field_data["options"]:
                        options = [FieldOption(**opt) for opt in field_data["options"]]
                    field_data_copy = field_data.copy()
                    field_data_copy["options"] = options
                    fields.append(FormField(**field_data_copy))

                result = await send_form(
                    title=request.arguments.get("title", ""),
                    fields=fields,
                    description=request.arguments.get("description"),
                    submit_button_text=request.arguments.get(
                        "submit_button_text", "Submit"
                    ),
                )
                return MCPToolCallResponse(
                    success=result.success,
                    result=result.model_dump(),
                    error=result.error,
                )

            elif request.tool_name == "send_confirm":
                from app.mcp.tools.send_confirm import send_confirm

                result = await send_confirm(
                    title=request.arguments.get("title", ""),
                    message=request.arguments.get("message", ""),
                    confirm_text=request.arguments.get("confirm_text", "Confirm"),
                    cancel_text=request.arguments.get("cancel_text", "Cancel"),
                )
                return MCPToolCallResponse(
                    success=result.success,
                    result=result.model_dump(),
                    error=result.error,
                )

            elif request.tool_name == "send_select":
                from app.mcp.tools.send_select import send_select

                # Parse options
                options = [
                    SelectOption(**opt)
                    for opt in request.arguments.get("options", [])
                ]

                result = await send_select(
                    title=request.arguments.get("title", ""),
                    options=options,
                    multiple=request.arguments.get("multiple", False),
                    description=request.arguments.get("description"),
                )
                return MCPToolCallResponse(
                    success=result.success,
                    result=result.model_dump(),
                    error=result.error,
                )

            else:
                return MCPToolCallResponse(
                    success=False,
                    error=f"Unknown tool: {request.tool_name}",
                )

        except Exception as e:
            logger.exception(f"[MCP] Tool call failed: {e}")
            return MCPToolCallResponse(success=False, error=str(e))
