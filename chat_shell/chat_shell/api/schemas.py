"""Chat Shell Service Input/Output Model Definitions.

This is the boundary contract for Chat Shell service.
External systems only need to send ChatEvent, and Chat Shell will
autonomously decide how to process it.

ChatEvent: Unified input for Chat Shell
StreamEvent: Unified output for Chat Shell (via AsyncIterator)
"""

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ChatEventType(str, Enum):
    """Chat event types."""

    MESSAGE = "message"  # User sends a message
    CANCEL = "cancel"  # Cancel current response
    FEEDBACK = "feedback"  # User feedback (like/dislike)


@dataclass
class ChatEvent:
    """Chat Event - Unified input for Chat Shell.

    External systems (e.g., WebSocket Namespace) only need to construct
    ChatEvent and send it to Chat Shell. Chat Shell will autonomously
    decide whether to respond and how to respond.

    This is the input contract at the microservice boundary.

    All configurations should be prepared by Backend. Chat Shell does not
    need to access the database.

    Attributes:
        type: Event type (MESSAGE, CANCEL, FEEDBACK)
        task_id: Task ID
        subtask_id: Subtask ID
        user_id: User ID
        user_name: User name (optional)
        message: Message content (text or vision message dict)
        model_config: Resolved model configuration (prepared by caller)
            Contains: api_key, base_url, model_id, model, default_headers
        system_prompt: Built system prompt (prepared by caller)
        history: Historical messages (loaded by caller)
        tools: Tool configurations (prepared by caller)
        extra_tools: Extra tool instances (e.g., knowledge base tools)
        enable_web_search: Whether to enable web search
        search_engine: Search engine to use
        max_iterations: Maximum iterations for tool calls
        message_id: Message ID for tracking
        shell_type: Shell type identifier
    """

    type: ChatEventType

    # Context identifiers
    task_id: int
    subtask_id: int
    user_id: int
    user_name: str = ""

    # Message content (required when type=MESSAGE)
    message: str | dict[str, Any] = ""  # Text message or vision message

    # Model configuration (resolved, prepared by caller)
    model_config: dict[str, Any] = field(default_factory=dict)
    system_prompt: str = ""

    # Optional configurations
    history: list[dict[str, Any]] | None = None
    tools: list[dict[str, Any]] | None = None
    extra_tools: list[Any] | None = None
    enable_web_search: bool = False
    search_engine: str | None = None
    max_iterations: int = 10

    # Metadata
    message_id: int | None = None
    shell_type: str = "Chat"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "type": self.type.value,
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "user_id": self.user_id,
            "user_name": self.user_name,
            "message": self.message,
            "model_config": self.model_config,
            "system_prompt": self.system_prompt,
            "history": self.history,
            "tools": self.tools,
            "enable_web_search": self.enable_web_search,
            "search_engine": self.search_engine,
            "max_iterations": self.max_iterations,
            "message_id": self.message_id,
            "shell_type": self.shell_type,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ChatEvent":
        """Create ChatEvent from dictionary."""
        return cls(
            type=ChatEventType(data["type"]),
            task_id=data["task_id"],
            subtask_id=data["subtask_id"],
            user_id=data["user_id"],
            user_name=data.get("user_name", ""),
            message=data.get("message", ""),
            model_config=data.get("model_config", {}),
            system_prompt=data.get("system_prompt", ""),
            history=data.get("history"),
            tools=data.get("tools"),
            extra_tools=data.get("extra_tools"),
            enable_web_search=data.get("enable_web_search", False),
            search_engine=data.get("search_engine"),
            max_iterations=data.get("max_iterations", 10),
            message_id=data.get("message_id"),
            shell_type=data.get("shell_type", "Chat"),
        )


class StreamEventType(str, Enum):
    """Stream output event types."""

    START = "start"  # Stream started
    CHUNK = "chunk"  # Content chunk
    DONE = "done"  # Stream completed
    ERROR = "error"  # Error occurred
    CANCELLED = "cancelled"  # Cancelled by user
    TOOL_CALL = "tool_call"  # Tool call started
    TOOL_RESULT = "tool_result"  # Tool call result
    THINKING = "thinking"  # Thinking/reasoning content


@dataclass
class StreamEvent:
    """Stream Output Event - Unified output for Chat Shell.

    Chat Shell returns streaming responses via AsyncIterator[StreamEvent].
    Callers can choose how to consume these events (push to WebSocket,
    SSE, or other channels).

    This is the output contract at the microservice boundary.

    Attributes:
        type: Event type
        task_id: Task ID
        subtask_id: Subtask ID
        content: Content string (for CHUNK, THINKING)
        offset: Current offset in the stream
        result: Result data (for DONE)
        error: Error message (for ERROR)
        message_id: Message ID for tracking
        shell_type: Shell type identifier
        tool_name: Tool name (for TOOL_CALL, TOOL_RESULT)
        tool_call_id: Tool call ID for correlation
        tool_input: Tool input parameters (for TOOL_CALL)
        tool_output: Tool output (for TOOL_RESULT)
        metadata: Additional metadata
    """

    type: StreamEventType

    # Context identifiers
    task_id: int
    subtask_id: int

    # Content
    content: str = ""
    offset: int = 0
    result: dict[str, Any] | None = None
    error: str | None = None

    # Metadata
    message_id: int | None = None
    shell_type: str = "Chat"

    # Tool call related
    tool_name: str | None = None
    tool_call_id: str | None = None
    tool_input: dict[str, Any] | None = None
    tool_output: str | None = None

    # Additional metadata
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        data: dict[str, Any] = {
            "type": self.type.value,
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "content": self.content,
            "offset": self.offset,
            "shell_type": self.shell_type,
        }

        # Only include non-None optional fields
        if self.result is not None:
            data["result"] = self.result
        if self.error is not None:
            data["error"] = self.error
        if self.message_id is not None:
            data["message_id"] = self.message_id
        if self.tool_name is not None:
            data["tool_name"] = self.tool_name
        if self.tool_call_id is not None:
            data["tool_call_id"] = self.tool_call_id
        if self.tool_input is not None:
            data["tool_input"] = self.tool_input
        if self.tool_output is not None:
            data["tool_output"] = self.tool_output
        if self.metadata is not None:
            data["metadata"] = self.metadata

        return data

    def to_sse(self) -> str:
        """Convert to SSE format."""
        return f"data: {json.dumps(self.to_dict())}\n\n"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StreamEvent":
        """Create StreamEvent from dictionary."""
        return cls(
            type=StreamEventType(data["type"]),
            task_id=data["task_id"],
            subtask_id=data["subtask_id"],
            content=data.get("content", ""),
            offset=data.get("offset", 0),
            result=data.get("result"),
            error=data.get("error"),
            message_id=data.get("message_id"),
            shell_type=data.get("shell_type", "Chat"),
            tool_name=data.get("tool_name"),
            tool_call_id=data.get("tool_call_id"),
            tool_input=data.get("tool_input"),
            tool_output=data.get("tool_output"),
            metadata=data.get("metadata"),
        )

    # Factory methods for common event types
    @classmethod
    def start(
        cls,
        task_id: int,
        subtask_id: int,
        message_id: int | None = None,
        shell_type: str = "Chat",
    ) -> "StreamEvent":
        """Create a START event."""
        return cls(
            type=StreamEventType.START,
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            shell_type=shell_type,
        )

    @classmethod
    def chunk(
        cls,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int = 0,
    ) -> "StreamEvent":
        """Create a CHUNK event."""
        return cls(
            type=StreamEventType.CHUNK,
            task_id=task_id,
            subtask_id=subtask_id,
            content=content,
            offset=offset,
        )

    @classmethod
    def done(
        cls,
        task_id: int,
        subtask_id: int,
        offset: int = 0,
        result: dict[str, Any] | None = None,
        message_id: int | None = None,
    ) -> "StreamEvent":
        """Create a DONE event."""
        return cls(
            type=StreamEventType.DONE,
            task_id=task_id,
            subtask_id=subtask_id,
            offset=offset,
            result=result,
            message_id=message_id,
        )

    @classmethod
    def error(
        cls,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: int | None = None,
    ) -> "StreamEvent":
        """Create an ERROR event."""
        return cls(
            type=StreamEventType.ERROR,
            task_id=task_id,
            subtask_id=subtask_id,
            error=error,
            message_id=message_id,
        )

    @classmethod
    def cancelled(
        cls,
        task_id: int,
        subtask_id: int,
    ) -> "StreamEvent":
        """Create a CANCELLED event."""
        return cls(
            type=StreamEventType.CANCELLED,
            task_id=task_id,
            subtask_id=subtask_id,
        )

    @classmethod
    def tool_call(
        cls,
        task_id: int,
        subtask_id: int,
        tool_name: str,
        tool_call_id: str,
        tool_input: dict[str, Any],
    ) -> "StreamEvent":
        """Create a TOOL_CALL event."""
        return cls(
            type=StreamEventType.TOOL_CALL,
            task_id=task_id,
            subtask_id=subtask_id,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            tool_input=tool_input,
        )

    @classmethod
    def tool_result(
        cls,
        task_id: int,
        subtask_id: int,
        tool_name: str,
        tool_call_id: str,
        tool_output: str,
    ) -> "StreamEvent":
        """Create a TOOL_RESULT event."""
        return cls(
            type=StreamEventType.TOOL_RESULT,
            task_id=task_id,
            subtask_id=subtask_id,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            tool_output=tool_output,
        )

    @classmethod
    def thinking(
        cls,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int = 0,
    ) -> "StreamEvent":
        """Create a THINKING event."""
        return cls(
            type=StreamEventType.THINKING,
            task_id=task_id,
            subtask_id=subtask_id,
            content=content,
            offset=offset,
        )
