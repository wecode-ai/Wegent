"""
API v1 schemas for chat_shell.

Defines request and response schemas for /v1/response API.
Design inspired by Anthropic Messages API + OpenAI Responses API.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, Field

# ============================================================
# Request Schemas
# ============================================================


class ModelConfig(BaseModel):
    """Model configuration (fully resolved, no placeholders)."""

    model_id: str = Field(
        ..., description="Model identifier (e.g., claude-3-5-sonnet-20241022)"
    )
    model: str = Field(..., description="Model type: openai, claude, google")
    api_key: str = Field(..., description="API Key (already decrypted)")
    base_url: Optional[str] = Field(
        None, description="API endpoint (optional, uses default)"
    )
    api_format: str = Field(
        "chat", description="API format: chat or responses (OpenAI)"
    )
    default_headers: dict[str, str] = Field(
        default_factory=dict, description="Custom request headers (already resolved)"
    )
    context_window: Optional[int] = Field(None, description="Context window size")
    max_output_tokens: Optional[int] = Field(None, description="Max output tokens")
    timeout: float = Field(120.0, description="Request timeout in seconds")
    max_retries: int = Field(3, description="Max retry count")
    retry_delay: float = Field(1.0, description="Retry delay in seconds")


class MessageContent(BaseModel):
    """Message content (multimodal)."""

    type: str = Field(..., description="Content type: text, image")
    text: Optional[str] = Field(None, description="Text content")
    source: Optional[dict] = Field(None, description="Image source (base64, url)")


class MessageItem(BaseModel):
    """Message in conversation history."""

    role: str = Field(..., description="Role: user, assistant, system, tool")
    content: Union[str, list[MessageContent]] = Field(
        ..., description="Message content"
    )
    name: Optional[str] = Field(None, description="Name for tool messages")
    tool_call_id: Optional[str] = Field(
        None, description="Tool call ID for tool results"
    )
    tool_calls: Optional[list[dict]] = Field(
        None, description="Tool calls made by assistant"
    )


class InputConfig(BaseModel):
    """Input configuration (flexible format)."""

    # Method 1: Simple text or vision message dict
    text: Optional[Union[str, dict]] = Field(
        None, description="Simple text input or vision message dict"
    )

    # Method 2: Multimodal content
    content: Optional[list[MessageContent]] = Field(
        None, description="Multimodal content"
    )

    # Method 3: Full conversation history
    messages: Optional[list[MessageItem]] = Field(
        None, description="Full conversation history (overrides session history)"
    )


class BuiltinToolConfig(BaseModel):
    """Built-in tool configuration."""

    enabled: bool = Field(True, description="Enable this tool")
    # Tool-specific options
    max_results: Optional[int] = Field(None, description="Max results (for search)")
    kb_ids: Optional[list[int]] = Field(None, description="Knowledge base IDs")


class CustomToolFunction(BaseModel):
    """Custom tool function definition."""

    name: str = Field(..., description="Function name")
    description: str = Field(..., description="Function description")
    parameters: dict = Field(..., description="JSON Schema for parameters")


class CustomTool(BaseModel):
    """Custom tool definition (OpenAI function calling format)."""

    type: str = Field("function", description="Tool type")
    function: CustomToolFunction = Field(..., description="Function definition")


class MCPServerConfig(BaseModel):
    """MCP server configuration."""

    name: str = Field(..., description="Server name")
    url: str = Field(..., description="Server URL")
    type: str = Field(
        "streamable-http", description="Transport type: sse, streamable-http, stdio"
    )
    auth: Optional[dict] = Field(None, description="Authentication config")


class SkillConfig(BaseModel):
    """Skill configuration."""

    name: str = Field(..., description="Skill name")
    version: Optional[str] = Field(None, description="Skill version")
    preload: bool = Field(False, description="Preload skill at start")


class ToolsConfig(BaseModel):
    """Tools configuration."""

    # Built-in tools
    builtin: Optional[dict[str, BuiltinToolConfig]] = Field(
        None, description="Built-in tool toggles"
    )

    # Custom tools
    custom: Optional[list[CustomTool]] = Field(
        None, description="Custom tool definitions"
    )

    # MCP servers
    mcp_servers: Optional[list[MCPServerConfig]] = Field(
        None, description="MCP servers"
    )

    # Skills
    skills: Optional[list[SkillConfig]] = Field(None, description="Skills to load")

    # Limits
    max_tool_calls: int = Field(
        10, description="Max tool calls (prevent infinite loops)"
    )
    tool_timeout_seconds: float = Field(
        60.0, description="Single tool execution timeout"
    )


class FeaturesConfig(BaseModel):
    """Features configuration."""

    deep_thinking: bool = Field(
        False, description="Enable deep thinking (reasoning models)"
    )
    clarification: bool = Field(False, description="Enable clarification questions")
    streaming: bool = Field(True, description="Enable streaming output")
    message_compression: bool = Field(True, description="Enable message compression")
    web_search: bool = Field(False, description="Enable web search tool")
    search_engine: Optional[str] = Field(None, description="Preferred search engine")


class Metadata(BaseModel):
    """Request metadata."""

    request_id: Optional[str] = Field(None, description="Request ID for tracking")
    user_id: Optional[int] = Field(None, description="User ID")
    user_name: Optional[str] = Field(None, description="User name")
    team_id: Optional[int] = Field(None, description="Team ID")
    team_name: Optional[str] = Field(None, description="Team name")
    task_id: Optional[int] = Field(None, description="Task ID")
    subtask_id: Optional[int] = Field(None, description="Subtask ID")
    user_subtask_id: Optional[int] = Field(
        None,
        description="User subtask ID for RAG result persistence (different from subtask_id which is AI response's subtask)",
    )
    message_id: Optional[int] = Field(
        None, description="Assistant message ID for frontend ordering"
    )
    user_message_id: Optional[int] = Field(
        None, description="User message ID for history exclusion"
    )
    bot_name: Optional[str] = Field(None, description="Bot name")
    bot_namespace: Optional[str] = Field(None, description="Bot namespace")
    trace_id: Optional[str] = Field(
        None, description="Trace ID for distributed tracing"
    )
    chat_type: Optional[str] = Field(None, description="Chat type: single or group")
    participants: Optional[list[str]] = Field(
        None, description="Group chat participants"
    )
    # Skill configuration (passed from Backend for HTTP mode)
    skill_names: Optional[list[str]] = Field(
        None, description="Available skill names for dynamic loading"
    )
    skill_configs: Optional[list[dict]] = Field(
        None, description="Skill tool configurations (with preload field)"
    )
    preload_skills: Optional[list[str]] = Field(
        None, description="Skills to preload at start (skill names)"
    )
    # Knowledge base configuration
    knowledge_base_ids: Optional[list[int]] = Field(
        None, description="Knowledge base IDs to search"
    )
    document_ids: Optional[list[int]] = Field(
        None,
        description="Document IDs to filter retrieval (when user references specific documents)",
    )
    is_user_selected_kb: Optional[bool] = Field(
        True,
        description="Whether KB is explicitly selected by user (strict mode) or inherited from task (relaxed mode)",
    )
    # Table configuration
    table_contexts: Optional[list[dict]] = Field(
        None, description="Table contexts for DataTableTool"
    )
    # Task data for MCP tools
    task_data: Optional[dict] = Field(None, description="Task data for MCP tools")


class AttachmentConfig(BaseModel):
    """Attachment configuration (preprocessed by caller)."""

    id: Optional[int] = Field(None, description="Attachment ID")
    filename: str = Field(..., description="Original filename")
    mime_type: str = Field(..., description="MIME type")
    content: Optional[str] = Field(None, description="Extracted text content")
    data: Optional[str] = Field(None, description="Base64 encoded data (for images)")


class KnowledgeContextItem(BaseModel):
    """Knowledge base context item."""

    kb_id: int = Field(..., description="Knowledge base ID")
    kb_name: str = Field(..., description="Knowledge base name")
    content: str = Field(..., description="Relevant content")


class KnowledgeContext(BaseModel):
    """Knowledge base context."""

    contexts: list[KnowledgeContextItem] = Field(
        default_factory=list, description="Knowledge contexts"
    )
    meta_prompt: Optional[str] = Field(None, description="System prompt injection")


class ToolResultItem(BaseModel):
    """Tool result from client execution."""

    id: str = Field(..., description="Tool call ID")
    output: Any = Field(..., description="Tool execution output")


class ResponseRequest(BaseModel):
    """
    /v1/response API request schema.

    Design inspired by Anthropic Messages API + OpenAI Responses API.
    Supports flexible tool provision and multimodal interaction.
    """

    # Model configuration (fully resolved)
    model_config_data: ModelConfig = Field(
        ..., alias="model_config", description="Model configuration"
    )

    # Generation parameters
    temperature: float = Field(0.7, ge=0.0, le=2.0, description="Sampling temperature")
    max_tokens: int = Field(4096, ge=1, description="Max output tokens")

    # Input (flexible format)
    input: InputConfig = Field(..., description="Input configuration")

    # Session management
    session_id: Optional[str] = Field(
        None, description="Session ID for multi-turn chat"
    )
    include_history: bool = Field(True, description="Include session history")

    # System prompt
    system: Optional[str] = Field(None, description="System prompt")

    # Tools configuration
    tools: Optional[ToolsConfig] = Field(None, description="Tools configuration")

    # Tool choice
    tool_choice: Union[str, dict, None] = Field(
        "auto", description="Tool choice: auto, none, required, or specific tool"
    )

    # Features
    features: FeaturesConfig = Field(
        default_factory=FeaturesConfig, description="Features configuration"
    )

    # Metadata
    metadata: Optional[Metadata] = Field(None, description="Request metadata")

    # Attachments (preprocessed)
    attachments: Optional[list[AttachmentConfig]] = Field(
        None, description="Attachments"
    )

    # Knowledge context
    knowledge_context: Optional[KnowledgeContext] = Field(
        None, description="Knowledge base context"
    )

    # Tool results (for continuing after tool.call_required)
    tool_results: Optional[list[ToolResultItem]] = Field(
        None, description="Tool results from client"
    )

    class Config:
        populate_by_name = True


# ============================================================
# Response/Event Schemas
# ============================================================


class ResponseEventType(str, Enum):
    """SSE event types."""

    RESPONSE_START = "response.start"
    CONTENT_DELTA = "content.delta"
    THINKING_DELTA = "thinking.delta"
    REASONING_DELTA = "reasoning.delta"
    TOOL_START = "tool.start"
    TOOL_PROGRESS = "tool.progress"
    TOOL_DONE = "tool.done"
    TOOL_CALL_REQUIRED = "tool.call_required"
    SOURCES_UPDATE = "sources.update"
    CLARIFICATION = "clarification"
    TOOL_LIMIT_REACHED = "tool_limit_reached"
    RESPONSE_DONE = "response.done"
    RESPONSE_CANCELLED = "response.cancelled"
    ERROR = "response.error"


class ContentDelta(BaseModel):
    """Content delta event data."""

    type: str = Field("text", description="Content type: text or image")
    text: Optional[str] = Field(None, description="Text content")
    data: Optional[str] = Field(None, description="Base64 image data")


class ThinkingDelta(BaseModel):
    """Thinking delta event data."""

    text: str = Field(..., description="Thinking content")


class ReasoningDelta(BaseModel):
    """Reasoning delta event data (for DeepSeek R1 etc.)."""

    text: str = Field(..., description="Reasoning content")


class ToolStart(BaseModel):
    """Tool start event data."""

    id: str = Field(..., description="Tool call ID")
    name: str = Field(..., description="Tool name")
    input: dict = Field(..., description="Tool input")
    display_name: Optional[str] = Field(None, description="Display name for UI")


class ToolProgress(BaseModel):
    """Tool progress event data."""

    id: str = Field(..., description="Tool call ID")
    progress: int = Field(..., ge=0, le=100, description="Progress percentage")
    message: Optional[str] = Field(None, description="Progress message")


class ToolDone(BaseModel):
    """Tool done event data."""

    id: str = Field(..., description="Tool call ID")
    output: Any = Field(..., description="Tool output")
    duration_ms: Optional[int] = Field(None, description="Execution duration in ms")
    error: Optional[str] = Field(None, description="Error message if failed")
    sources: Optional[list[dict]] = Field(None, description="Source references")
    display_name: Optional[str] = Field(
        None, description="Display name for UI (updates title on completion)"
    )


class ToolCallRequired(BaseModel):
    """Tool call required event data (for client-side execution)."""

    id: str = Field(..., description="Tool call ID")
    name: str = Field(..., description="Tool name")
    input: dict = Field(..., description="Tool input")


class SourceItem(BaseModel):
    """Source reference item for knowledge base citations."""

    index: Optional[int] = Field(None, description="Source index number (1, 2, 3...)")
    title: str = Field(..., description="Source title/document name")
    kb_id: Optional[int] = Field(None, description="Knowledge base ID")
    url: Optional[str] = Field(None, description="Source URL (for web sources)")
    snippet: Optional[str] = Field(None, description="Content snippet")


class SourcesUpdate(BaseModel):
    """Sources update event data."""

    sources: list[SourceItem] = Field(..., description="Source references")


class ClarificationOption(BaseModel):
    """Clarification option."""

    label: str = Field(..., description="Option label")
    value: str = Field(..., description="Option value")


class Clarification(BaseModel):
    """Clarification event data."""

    question: str = Field(..., description="Clarification question")
    options: Optional[list[ClarificationOption]] = Field(None, description="Options")


class ToolLimitReached(BaseModel):
    """Tool limit reached event data."""

    max_calls: int = Field(..., description="Max allowed tool calls")
    message: str = Field(..., description="Limit message")


class UsageInfo(BaseModel):
    """Token usage information."""

    input_tokens: int = Field(..., description="Input tokens")
    output_tokens: int = Field(..., description="Output tokens")
    total_tokens: Optional[int] = Field(None, description="Total tokens")
    cache_read_input_tokens: Optional[int] = Field(
        None, description="Cache read tokens"
    )
    cache_creation_input_tokens: Optional[int] = Field(
        None, description="Cache creation tokens"
    )


class ResponseDone(BaseModel):
    """Response done event data."""

    id: str = Field(..., description="Response ID")
    usage: Optional[UsageInfo] = Field(None, description="Token usage")
    stop_reason: str = Field(
        ..., description="Stop reason: end_turn, tool_use, max_tokens"
    )
    sources: Optional[list[SourceItem]] = Field(None, description="Source references")


class ResponseCancelled(BaseModel):
    """Response cancelled event data."""

    id: str = Field(..., description="Response ID")
    partial_content: Optional[str] = Field(
        None, description="Partial content generated"
    )


class ErrorEvent(BaseModel):
    """Error event data."""

    code: str = Field(..., description="Error code")
    message: str = Field(..., description="Error message")
    details: Optional[dict] = Field(None, description="Error details")


class ResponseEvent(BaseModel):
    """Generic response event."""

    event: ResponseEventType = Field(..., description="Event type")
    data: Union[
        ContentDelta,
        ThinkingDelta,
        ReasoningDelta,
        ToolStart,
        ToolProgress,
        ToolDone,
        ToolCallRequired,
        SourcesUpdate,
        Clarification,
        ToolLimitReached,
        ResponseDone,
        ResponseCancelled,
        ErrorEvent,
        dict,
    ] = Field(..., description="Event data")


# ============================================================
# Other Schemas
# ============================================================


class CancelRequest(BaseModel):
    """Cancel request schema."""

    request_id: str = Field(..., description="Request ID to cancel")


class CancelResponse(BaseModel):
    """Cancel response schema."""

    success: bool = Field(..., description="Whether cancel was successful")
    message: str = Field(..., description="Status message")


class StorageHealth(BaseModel):
    """Storage health info."""

    type: str = Field(..., description="Storage type")
    status: str = Field(..., description="Storage status")


class ModelProviderHealth(BaseModel):
    """Model provider health info."""

    status: str = Field(..., description="Provider status")


class HealthResponse(BaseModel):
    """Health check response schema."""

    status: str = Field(..., description="Overall status: healthy, degraded, unhealthy")
    version: str = Field(..., description="chat_shell version")
    uptime_seconds: int = Field(..., description="Service uptime in seconds")
    active_streams: int = Field(0, description="Active stream count")
    storage: Optional[StorageHealth] = Field(None, description="Storage health")
    model_providers: Optional[dict[str, str]] = Field(
        None, description="Model provider status"
    )
