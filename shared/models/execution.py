# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified execution data protocol.

All execution services (backend, chat_shell, executor, executor_manager)
use these classes. Adding a new field only requires changing this file.

Design principles:
- Use @dataclass for type safety
- Use dataclasses.asdict() for automatic serialization
- Use dacite.from_dict() for automatic deserialization
- All modules import the same classes
"""

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional

from dacite import Config, from_dict


class EventType(str, Enum):
    """Unified execution event types.

    Combines event types from:
    - ExecutionEvent (start, chunk, done, error, progress, cancel)
    - ChatEventType (start, chunk, thinking, tool, tool_start, tool_result, done, cancelled, error)
    """

    START = "start"
    CHUNK = "chunk"
    THINKING = "thinking"
    TOOL = "tool"  # Generic tool event (for tool callbacks)
    TOOL_START = "tool_start"
    TOOL_RESULT = "tool_result"
    PROGRESS = "progress"
    DONE = "done"
    ERROR = "error"
    CANCEL = "cancel"
    CANCELLED = "cancelled"


@dataclass
class ExecutionRequest:
    """Unified execution request - used by all modules.

    This is the single source of truth for execution requests.
    All modules (backend, chat_shell, executor, executor_manager) use this class.
    Adding a new field only requires changing this file.
    """

    # === Task Identification ===
    task_id: int = 0
    subtask_id: int = 0
    subtask_next_id: Optional[int] = None  # From Task
    team_id: int = 0
    team_name: str = ""
    team_namespace: Optional[str] = None  # From Task: Team namespace for skill lookup
    subtask_title: Optional[str] = None  # From Task
    task_title: Optional[str] = None  # From Task

    # === User Information ===
    # {id, name, git_domain, git_token, git_id, git_login, git_email, user_name}
    user: dict = field(default_factory=dict)
    user_id: int = 0  # From ChatRequest
    user_name: str = ""  # From ChatRequest

    # === Bot Configuration ===
    # [{id, name, shell_type, agent_config, system_prompt, mcp_servers, skills, role, base_image}]
    bot: list = field(default_factory=list)
    bot_name: str = ""  # From ChatRequest
    bot_namespace: str = ""  # From ChatRequest

    # === Model Configuration ===
    # {provider, model_id, api_key, base_url, ...}
    model_config: dict = field(default_factory=dict)

    # === Prompt ===
    system_prompt: str = ""
    prompt: str = ""  # User message

    # === Feature Toggles ===
    enable_tools: bool = True
    enable_web_search: bool = False
    enable_clarification: bool = False
    enable_deep_thinking: bool = True
    search_engine: Optional[str] = None  # From ChatRequest

    # === Skill Configuration ===
    skill_names: list = field(default_factory=list)
    skill_configs: list = field(default_factory=list)
    preload_skills: list = field(default_factory=list)
    user_selected_skills: list = field(default_factory=list)
    skills: list = field(
        default_factory=list
    )  # From ChatRequest: Skill metadata for prompt injection

    # === MCP Configuration ===
    # Format: [{"name": "server_name", "url": "...", "type": "...", "auth": {...}}]
    mcp_servers: list = field(default_factory=list)

    # === Knowledge Base Configuration ===
    knowledge_base_ids: Optional[list] = None
    document_ids: Optional[list] = None
    table_contexts: list = field(default_factory=list)
    is_user_selected_kb: bool = True

    # === Workspace Configuration ===
    workspace: dict = field(default_factory=dict)

    # === Git Configuration (from Task) ===
    git_domain: Optional[str] = None
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    branch_name: Optional[str] = None
    git_url: Optional[str] = None

    # === Session Configuration ===
    message_id: Optional[int] = None
    user_message_id: Optional[int] = None
    user_subtask_id: Optional[int] = (
        None  # From ChatRequest: User subtask ID for RAG result persistence
    )
    is_group_chat: bool = False
    history_limit: Optional[int] = None
    new_session: bool = False
    collaboration_model: str = "single"
    mode: Optional[str] = (
        None  # From Task: Collaboration mode (e.g., "coordinate", "collaborate")
    )
    request_id: str = ""  # From ChatRequest

    # === Context Data (from ChatRequest) ===
    contexts: list = field(default_factory=list)
    history: list = field(default_factory=list)

    # === Authentication ===
    auth_token: str = ""
    task_token: str = ""
    backend_url: str = ""

    # === Attachments ===
    attachments: list = field(default_factory=list)

    # === Subscription Task ===
    is_subscription: bool = False
    system_mcp_config: Optional[dict] = None

    # === Task Data (from ChatRequest) ===
    task_data: Optional[dict] = None  # Task data for MCP tools
    extra_tools: list = field(default_factory=list)  # Extra tools to add
    timezone: str = "Asia/Shanghai"  # User timezone for CreateSubscriptionTool

    # === Task Status (from Task) ===
    status: Optional[str] = None
    progress: Optional[int] = None
    type: Optional[str] = None  # Task type: "online" or "offline"

    # === Executor Information (from Task) ===
    executor_name: Optional[str] = None
    executor_namespace: Optional[str] = None

    # === Timestamps (from Task) ===
    created_at: Optional[str] = None  # ISO format datetime
    updated_at: Optional[str] = None  # ISO format datetime

    # === Tracing ===
    trace_context: Optional[dict] = None

    # ========================================
    # Adding a new field only requires adding one line here.
    # All modules automatically get the new field.
    # ========================================

    def to_dict(self) -> dict[str, Any]:
        """Convert to dict - automatically serializes all fields."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExecutionRequest":
        """Create from dict - automatically deserializes.

        Handles type coercion for fields that may have inconsistent types:
        - mcp_servers: converts dict to list format if needed
        """
        # Handle mcp_servers type inconsistency
        # Ghost CRD stores as dict {"name": {...}}, but we need list [{"name": "...", ...}]
        if "mcp_servers" in data and isinstance(data.get("mcp_servers"), dict):
            mcp_dict = data["mcp_servers"]
            mcp_list = []
            for server_name, server_config in mcp_dict.items():
                if isinstance(server_config, dict):
                    server_entry = {"name": server_name, **server_config}
                    # Convert "headers" to "auth" for chat_shell compatibility
                    if "headers" in server_entry and "auth" not in server_entry:
                        server_entry["auth"] = server_entry.pop("headers")
                    mcp_list.append(server_entry)
            data = {**data, "mcp_servers": mcp_list}

        return from_dict(
            data_class=cls,
            data=data,
            config=Config(strict=False),  # Ignore unknown fields
        )


@dataclass
class ExecutionEvent:
    """Unified execution event - used by all modules.

    This is the single source of truth for execution events.
    All modules (chat_shell, executor, executor_manager) return this format.
    Backend processes this unified format.
    """

    # === Event Identification ===
    type: str = "chunk"  # EventType value
    task_id: int = 0
    subtask_id: int = 0

    # === Content Data ===
    content: str = ""
    offset: int = 0

    # === Result Data ===
    # {value, thinking, workbench, blocks, reasoning_content, ...}
    result: Optional[dict] = None

    # === Progress Data ===
    progress: int = 0
    status: str = ""

    # === Error Data ===
    error: Optional[str] = None
    error_code: Optional[str] = None

    # === Tool Data ===
    tool_name: Optional[str] = None
    tool_use_id: Optional[str] = None  # Anthropic tool_use_id
    tool_input: Optional[dict] = None
    tool_output: Optional[Any] = None

    # === Metadata ===
    message_id: Optional[int] = None
    executor_name: Optional[str] = None
    executor_namespace: Optional[str] = None
    timestamp: Optional[str] = None

    # === Additional Data (from ChatEvent) ===
    data: dict = field(default_factory=dict)  # Generic data field for flexibility

    # ========================================
    # Adding a new field only requires adding one line here.
    # ========================================

    def to_dict(self) -> dict[str, Any]:
        """Convert to dict - automatically serializes all fields."""
        result = asdict(self)
        # Ensure type is string value, not enum
        if isinstance(result.get("type"), EventType):
            result["type"] = result["type"].value
        return result

    def to_sse(self) -> str:
        """Convert to SSE format."""
        import json

        return f"data: {json.dumps(self.to_dict())}\n\n"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExecutionEvent":
        """Create from dict - automatically deserializes."""
        # Handle EventType enum conversion
        if "type" in data:
            type_value = data.get("type", "chunk")
            if isinstance(type_value, EventType):
                data = {**data, "type": type_value.value}
            elif isinstance(type_value, str):
                # Validate it's a valid EventType value
                try:
                    EventType(type_value)
                except ValueError:
                    data = {**data, "type": "chunk"}

        return from_dict(
            data_class=cls,
            data=data,
            config=Config(strict=False),  # Ignore unknown fields
        )

    @classmethod
    def create(
        cls,
        event_type: EventType,
        task_id: int,
        subtask_id: int,
        **kwargs: Any,
    ) -> "ExecutionEvent":
        """Factory method to create event with EventType enum."""
        return cls(
            type=event_type.value,
            task_id=task_id,
            subtask_id=subtask_id,
            **kwargs,
        )
