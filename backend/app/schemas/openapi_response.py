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


class InputMessage(BaseModel):
    """Input message item for conversation history."""

    type: Literal["message"] = "message"
    role: Literal["user", "assistant"]
    content: Union[str, List[InputTextContent]]
    id: Optional[str] = None


class InputFunctionCall(BaseModel):
    """Function call input item from previous response.

    Used when feeding back function calls from a previous response
    for multi-turn conversations with tool use.
    """

    type: Literal["function_call"] = "function_call"
    id: str = Field(..., description="Unique ID of the function call")
    call_id: str = Field(..., description="Call ID matching the function call")
    name: str = Field(..., description="Name of the function")
    arguments: str = Field(..., description="JSON string of arguments")
    status: Optional[Literal["in_progress", "completed", "incomplete", "failed"]] = None
    output: Optional[str] = Field(default=None, description="Output from the function")


class InputFunctionCallOutput(BaseModel):
    """Function call output input item.

    Used to provide the output of a function call back to the model.
    """

    type: Literal["function_call_output"] = "function_call_output"
    call_id: str = Field(
        ..., description="Call ID of the function call this output is for"
    )
    output: str = Field(..., description="Output from the function call")


class InputItemReference(BaseModel):
    """Reference to an item from a previous response.

    Used to reference items by ID from previous responses.
    """

    type: Literal["item_reference"] = "item_reference"
    id: str = Field(..., description="ID of the item to reference")


# Union type for all input item types
InputItem = Union[
    InputMessage, InputFunctionCall, InputFunctionCallOutput, InputItemReference
]


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


# ============================================================
# All OpenAI Response Output Item Types
# Reference: https://platform.openai.com/docs/api-reference/responses/object#responses-object-output
# ============================================================


class FunctionToolCall(BaseModel):
    """A tool call to run a function.

    See the function calling guide for more information.
    """

    type: Literal["function_call"] = "function_call"
    id: str = Field(..., description="Unique ID of the function call")
    call_id: str = Field(
        ..., description="Unique ID of the tool call generated by the model"
    )
    name: str = Field(..., description="The name of the function to call")
    arguments: str = Field(..., description="JSON string of arguments for the function")
    status: Literal["in_progress", "completed", "incomplete", "failed"] = "in_progress"
    output: Optional[str] = Field(default=None, description="Output from the function")


class FileSearchToolCall(BaseModel):
    """The results of a file search tool call.

    See the file search guide for more information.
    """

    type: Literal["file_search_call"] = "file_search_call"
    id: str = Field(..., description="Unique ID of the file search call")
    status: Literal["in_progress", "completed", "incomplete", "failed"] = "in_progress"
    queries: List[str] = Field(default_factory=list, description="Search queries used")
    results: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="File search results"
    )


class WebSearchToolCall(BaseModel):
    """The results of a web search tool call.

    See the web search guide for more information.
    """

    type: Literal["web_search_call"] = "web_search_call"
    id: str = Field(..., description="Unique ID of the web search call")
    status: Literal["in_progress", "completed", "searching", "failed"] = "in_progress"


class ComputerToolCall(BaseModel):
    """A tool call to a computer use tool.

    See the computer use guide for more information.
    """

    type: Literal["computer_call"] = "computer_call"
    id: str = Field(..., description="Unique ID of the computer call")
    call_id: str = Field(
        ..., description="Unique ID of the tool call generated by the model"
    )
    action: Dict[str, Any] = Field(
        ..., description="Action to perform (click, type, screenshot, etc.)"
    )
    pending_safety_checks: List[Dict[str, Any]] = Field(
        default_factory=list, description="Pending safety checks"
    )
    status: Literal["in_progress", "completed", "incomplete"] = "in_progress"


class ReasoningItem(BaseModel):
    """A description of the chain of thought used by a reasoning model.

    Be sure to include these items in your input to the Responses API
    for subsequent turns of a conversation if you are manually managing context.
    """

    type: Literal["reasoning"] = "reasoning"
    id: str = Field(..., description="Unique ID of the reasoning item")
    summary: List[Dict[str, Any]] = Field(
        default_factory=list, description="Summary of the reasoning"
    )
    status: Optional[Literal["in_progress", "completed", "incomplete"]] = None


class CompactionItem(BaseModel):
    """A compaction item generated by the v1/responses/compact API."""

    type: Literal["compaction"] = "compaction"
    id: str = Field(..., description="Unique ID of the compaction item")
    summary: str = Field(..., description="Compacted summary of previous context")


class ImageGenerationCall(BaseModel):
    """An image generation request made by the model."""

    type: Literal["image_generation_call"] = "image_generation_call"
    id: str = Field(..., description="Unique ID of the image generation call")
    status: Literal["in_progress", "completed", "generating", "failed"] = "in_progress"
    result: Optional[str] = Field(
        default=None, description="Generated image encoded in base64"
    )


class CodeInterpreterToolCall(BaseModel):
    """A tool call to run code."""

    type: Literal["code_interpreter_call"] = "code_interpreter_call"
    id: str = Field(..., description="Unique ID of the code interpreter call")
    code: str = Field(..., description="Code to execute")
    status: Literal["in_progress", "completed", "incomplete", "failed"] = "in_progress"
    results: List[Dict[str, Any]] = Field(
        default_factory=list, description="Code execution results"
    )


class LocalShellCallAction(BaseModel):
    """Execute a shell command on the server."""

    type: Literal["exec"] = "exec"
    command: List[str] = Field(..., description="The command to run")
    env: Dict[str, str] = Field(
        default_factory=dict, description="Environment variables"
    )
    timeout_ms: Optional[int] = Field(
        default=None, description="Timeout in milliseconds"
    )
    user: Optional[str] = Field(default=None, description="User to run command as")
    working_directory: Optional[str] = Field(
        default=None, description="Working directory"
    )


class LocalShellCall(BaseModel):
    """A tool call to run a command on the local shell."""

    type: Literal["local_shell_call"] = "local_shell_call"
    id: str = Field(..., description="Unique ID of the local shell call")
    call_id: str = Field(..., description="Unique ID of the tool call from the model")
    action: LocalShellCallAction = Field(..., description="Shell action to execute")
    status: Literal["in_progress", "completed", "incomplete"] = "in_progress"


class ShellToolCall(BaseModel):
    """A tool call that executes one or more shell commands in a managed environment."""

    type: Literal["shell_call"] = "shell_call"
    id: str = Field(..., description="Unique ID of the shell call")
    call_id: str = Field(..., description="Unique ID of the tool call from the model")
    action: Dict[str, Any] = Field(..., description="Shell action configuration")
    status: Literal["in_progress", "completed", "incomplete"] = "in_progress"


class ShellToolCallOutput(BaseModel):
    """The output of a shell tool call that was emitted."""

    type: Literal["shell_call_output"] = "shell_call_output"
    id: str = Field(..., description="Unique ID of the shell call output")
    call_id: str = Field(..., description="ID of the associated shell call")
    output: str = Field(..., description="Command output")
    status: Literal["in_progress", "completed", "incomplete"] = "completed"


class ApplyPatchToolCall(BaseModel):
    """A tool call that applies file diffs by creating, deleting, or updating files."""

    type: Literal["apply_patch_call"] = "apply_patch_call"
    id: str = Field(..., description="Unique ID of the apply patch call")
    call_id: str = Field(..., description="Unique ID of the tool call from the model")
    patch: str = Field(..., description="Patch content in unified diff format")
    status: Literal["in_progress", "completed", "incomplete"] = "in_progress"


class ApplyPatchToolCallOutput(BaseModel):
    """The output emitted by an apply patch tool call."""

    type: Literal["apply_patch_call_output"] = "apply_patch_call_output"
    id: str = Field(..., description="Unique ID of the patch output")
    call_id: str = Field(..., description="ID of the associated apply patch call")
    output: str = Field(..., description="Patch application result")
    status: Literal["in_progress", "completed", "incomplete"] = "completed"


class McpCall(BaseModel):
    """An invocation of a tool on an MCP server."""

    type: Literal["mcp_call"] = "mcp_call"
    id: str = Field(..., description="Unique ID of the MCP tool call")
    name: str = Field(..., description="Name of the tool that was run")
    arguments: str = Field(..., description="JSON string of arguments for the tool")
    server_label: str = Field(
        ..., description="Label of the MCP server running the tool"
    )
    status: Optional[
        Literal["in_progress", "completed", "incomplete", "calling", "failed"]
    ] = "in_progress"
    output: Optional[str] = Field(default=None, description="Output from the tool call")
    error: Optional[str] = Field(default=None, description="Error from the tool call")
    approval_request_id: Optional[str] = Field(
        default=None, description="ID for MCP tool call approval request"
    )


class McpListToolsTool(BaseModel):
    """A tool available on an MCP server."""

    name: str = Field(..., description="Name of the tool")
    description: Optional[str] = Field(default=None, description="Tool description")
    input_schema: Dict[str, Any] = Field(
        default_factory=dict, description="JSON schema for tool input"
    )
    annotations: Optional[Dict[str, Any]] = Field(
        default=None, description="Additional tool annotations"
    )


class McpListTools(BaseModel):
    """A list of tools available on an MCP server."""

    type: Literal["mcp_list_tools"] = "mcp_list_tools"
    id: str = Field(..., description="Unique ID of the list")
    server_label: str = Field(..., description="Label of the MCP server")
    tools: List[McpListToolsTool] = Field(
        default_factory=list, description="Available tools"
    )
    error: Optional[str] = Field(
        default=None, description="Error if server could not list tools"
    )


class McpApprovalRequest(BaseModel):
    """A request for human approval of a tool invocation."""

    type: Literal["mcp_approval_request"] = "mcp_approval_request"
    id: str = Field(..., description="Unique ID of the approval request")
    name: str = Field(..., description="Name of the tool to run")
    arguments: str = Field(..., description="JSON string of arguments for the tool")
    server_label: str = Field(..., description="Label of the MCP server")


class CustomToolCall(BaseModel):
    """A call to a custom tool created by the model."""

    type: Literal["custom_tool_call"] = "custom_tool_call"
    id: str = Field(..., description="Unique ID of the custom tool call")
    call_id: str = Field(..., description="Unique ID of the tool call from the model")
    name: str = Field(..., description="Name of the custom tool")
    arguments: str = Field(..., description="JSON string of arguments")
    status: Literal["in_progress", "completed", "incomplete", "failed"] = "in_progress"
    output: Optional[str] = Field(default=None, description="Tool output")


class FunctionCallOutput(BaseModel):
    """The output of a function tool call.

    Used to represent the result of a function that was executed.
    This is an OUTPUT item type (appears in response.output array),
    different from InputFunctionCallOutput which is for INPUT items.
    """

    type: Literal["function_call_output"] = "function_call_output"
    id: str = Field(..., description="Unique ID of the function call output")
    call_id: str = Field(
        ..., description="Call ID of the function call this output is for"
    )
    output: str = Field(..., description="Output from the function call")
    status: Literal["completed", "failed"] = "completed"
    error: Optional[str] = Field(default=None, description="Error message if failed")


# Union type for all possible output items
ResponseOutputItem = Union[
    OutputMessage,
    FunctionToolCall,
    FunctionCallOutput,
    FileSearchToolCall,
    WebSearchToolCall,
    ComputerToolCall,
    ReasoningItem,
    CompactionItem,
    ImageGenerationCall,
    CodeInterpreterToolCall,
    LocalShellCall,
    ShellToolCall,
    ShellToolCallOutput,
    ApplyPatchToolCall,
    ApplyPatchToolCallOutput,
    McpCall,
    McpListTools,
    McpApprovalRequest,
    CustomToolCall,
]


class ResponseError(BaseModel):
    """Error information when response fails."""

    code: str
    message: str


class ResponseObject(BaseModel):
    """Response object compatible with OpenAI Responses API.

    The output array can contain various item types:
    - message: Text output from the model
    - function_call: Tool/function calls
    - mcp_call: MCP server tool calls
    - reasoning: Chain of thought reasoning
    - web_search_call: Web search results
    - And many more (see ResponseOutputItem union type)
    """

    id: str  # Format: resp_{task_id}
    object: Literal["response"] = "response"
    created_at: int  # Unix timestamp
    status: Literal[
        "completed", "failed", "in_progress", "cancelled", "queued", "incomplete"
    ]
    error: Optional[ResponseError] = None
    model: str  # The model string from request
    output: List[ResponseOutputItem] = Field(default_factory=list)
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
