"""
WeGent request adapter.

Converts WeGent internal request format to /v1/response format.
This adapter is used by Backend when calling chat_shell.
"""

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class UserInfo:
    """User information from WeGent."""

    id: int
    name: str
    git_domain: Optional[str] = None
    git_token: Optional[str] = None
    git_id: Optional[str] = None
    git_login: Optional[str] = None
    git_email: Optional[str] = None
    user_name: Optional[str] = None


@dataclass
class BotConfig:
    """Bot configuration from WeGent."""

    id: int
    name: str
    shell_type: str  # "Chat", "ClaudeCode", "Agno"
    agent_config: dict  # model, api_key, etc.
    system_prompt: str
    mcp_servers: list[dict] = field(default_factory=list)
    skills: list[dict] = field(default_factory=list)
    role: Optional[str] = None
    base_image: Optional[str] = None


@dataclass
class AttachmentInfo:
    """Attachment information from WeGent."""

    id: int
    original_filename: str
    file_extension: str
    file_size: int
    mime_type: str
    content: Optional[str] = None  # Extracted text content (processed by Backend)
    data: Optional[str] = None  # Base64 encoded data (for images)


@dataclass
class WeGentChatRequest:
    """
    WeGent internal request format.

    This is the format used by Backend when dispatching to executor.
    The adapter converts this to ResponseRequest format.
    """

    # Task identifiers
    subtask_id: int
    task_id: int

    # User information
    user: UserInfo

    # Bot configuration (may have multiple bots, chat uses first one)
    bot: list[BotConfig]

    # Team information
    team_id: int

    # Request content
    prompt: str  # Aggregated prompt
    attachments: list[AttachmentInfo] = field(default_factory=list)

    # Status
    status: str = "pending"

    # Authentication
    auth_token: str = ""  # JWT token for skill downloads

    # Session ID (derived from task_id)
    @property
    def session_id(self) -> str:
        return f"task-{self.task_id}"

    # Chat history (optional, loaded by Backend)
    messages: list[dict] = field(default_factory=list)


class WeGentToResponseAdapter:
    """
    Adapter to convert WeGent request to /v1/response format.

    This adapter is used by Backend when:
    1. Calling chat_shell via HTTP (POST /v1/response)
    2. Importing chat_shell as package (creating AgentConfig)

    The adapter handles:
    - Extracting model config from bot.agent_config
    - Converting attachments to the expected format
    - Building tools config from bot settings
    - Constructing metadata
    """

    @staticmethod
    def to_response_request(wegent_request: WeGentChatRequest) -> dict:
        """
        Convert WeGent request to /v1/response request body.

        Args:
            wegent_request: WeGent internal request

        Returns:
            Dict suitable for /v1/response API
        """
        # Get first bot config
        bot = wegent_request.bot[0] if wegent_request.bot else None
        if not bot:
            raise ValueError("No bot configuration provided")

        agent_config = bot.agent_config or {}

        # Build model_config
        model_config = WeGentToResponseAdapter._build_model_config(agent_config)

        # Build input
        input_config = WeGentToResponseAdapter._build_input(wegent_request)

        # Build tools config
        tools_config = WeGentToResponseAdapter._build_tools_config(bot)

        # Build metadata
        metadata = WeGentToResponseAdapter._build_metadata(wegent_request)

        # Build attachments
        attachments = WeGentToResponseAdapter._build_attachments(
            wegent_request.attachments
        )

        return {
            "model_config": model_config,
            "temperature": agent_config.get("temperature", 0.7),
            "max_tokens": agent_config.get("max_tokens", 4096),
            "input": input_config,
            "session_id": wegent_request.session_id,
            "include_history": True,
            "system": bot.system_prompt,
            "tools": tools_config,
            "tool_choice": agent_config.get("tool_choice", "auto"),
            "features": {
                "deep_thinking": agent_config.get("deep_thinking", False),
                "clarification": agent_config.get("clarification", False),
                "streaming": True,
                "message_compression": agent_config.get("message_compression", True),
            },
            "metadata": metadata,
            "attachments": attachments,
        }

    @staticmethod
    def _build_model_config(agent_config: dict) -> dict:
        """Build model_config from agent_config."""
        # Extract model configuration
        model_spec = agent_config.get("model_spec", {})

        return {
            "model_id": model_spec.get("model_id", agent_config.get("model", "")),
            "model": model_spec.get("model", agent_config.get("model_type", "openai")),
            "api_key": model_spec.get("api_key", agent_config.get("api_key", "")),
            "base_url": model_spec.get("base_url", agent_config.get("base_url")),
            "api_format": model_spec.get("api_format", "chat"),
            "default_headers": model_spec.get("default_headers", {}),
            "context_window": model_spec.get("context_window"),
            "max_output_tokens": model_spec.get("max_output_tokens"),
            "timeout": model_spec.get("timeout", 120),
            "max_retries": model_spec.get("max_retries", 3),
        }

    @staticmethod
    def _build_input(wegent_request: WeGentChatRequest) -> dict:
        """Build input config from WeGent request."""
        # If messages are provided, use them
        if wegent_request.messages:
            return {
                "messages": [
                    {
                        "role": msg.get("role", "user"),
                        "content": msg.get("content", ""),
                    }
                    for msg in wegent_request.messages
                ]
            }

        # Otherwise, use prompt as simple text
        return {"text": wegent_request.prompt}

    @staticmethod
    def _build_tools_config(bot: BotConfig) -> dict:
        """Build tools config from bot settings."""
        tools_config = {
            "builtin": {},
            "custom": [],
            "mcp_servers": [],
            "skills": [],
            "max_tool_calls": 10,
            "tool_timeout_seconds": 60.0,
        }

        # MCP servers
        if bot.mcp_servers:
            for server in bot.mcp_servers:
                tools_config["mcp_servers"].append(
                    {
                        "name": server.get("name", ""),
                        "url": server.get("url", ""),
                        "auth": server.get("auth"),
                    }
                )

        # Skills
        if bot.skills:
            for skill in bot.skills:
                tools_config["skills"].append(
                    {
                        "name": skill.get("name", ""),
                        "version": skill.get("version"),
                        "preload": skill.get("preload", False),
                    }
                )

        return tools_config

    @staticmethod
    def _build_metadata(wegent_request: WeGentChatRequest) -> dict:
        """Build metadata from WeGent request."""
        return {
            "request_id": f"subtask-{wegent_request.subtask_id}",
            "user_id": wegent_request.user.id,
            "user_name": wegent_request.user.name,
            "team_id": wegent_request.team_id,
            "trace_id": f"task-{wegent_request.task_id}",
        }

    @staticmethod
    def _build_attachments(attachments: list[AttachmentInfo]) -> list[dict]:
        """Build attachments list from AttachmentInfo."""
        result = []
        for att in attachments:
            attachment = {
                "id": att.id,
                "filename": att.original_filename,
                "mime_type": att.mime_type,
            }

            # Add content or data based on type
            if att.content:
                attachment["content"] = att.content
            if att.data:
                attachment["data"] = att.data

            result.append(attachment)

        return result

    @staticmethod
    def to_agent_config(wegent_request: WeGentChatRequest) -> "AgentConfig":
        """
        Convert WeGent request to AgentConfig for package mode.

        Args:
            wegent_request: WeGent internal request

        Returns:
            AgentConfig suitable for ChatAgent
        """
        from chat_shell.agent import AgentConfig

        # Build the response request dict first
        request_dict = WeGentToResponseAdapter.to_response_request(wegent_request)

        # Create AgentConfig
        return AgentConfig(
            model_config=request_dict["model_config"],
            system_prompt=request_dict.get("system"),
            temperature=request_dict.get("temperature", 0.7),
            max_tokens=request_dict.get("max_tokens", 4096),
            tools_config=request_dict.get("tools"),
            tool_choice=request_dict.get("tool_choice", "auto"),
            enable_deep_thinking=request_dict.get("features", {}).get(
                "deep_thinking", False
            ),
            enable_message_compression=request_dict.get("features", {}).get(
                "message_compression", True
            ),
            metadata=request_dict.get("metadata", {}),
        )


def create_wegent_request(
    subtask_id: int,
    task_id: int,
    user_id: int,
    user_name: str,
    team_id: int,
    prompt: str,
    bot_config: dict,
    **kwargs,
) -> WeGentChatRequest:
    """
    Factory function to create WeGentChatRequest.

    Args:
        subtask_id: Subtask ID
        task_id: Task ID
        user_id: User ID
        user_name: User name
        team_id: Team ID
        prompt: User prompt
        bot_config: Bot configuration dict
        **kwargs: Additional fields (attachments, auth_token, etc.)

    Returns:
        WeGentChatRequest instance
    """
    user = UserInfo(id=user_id, name=user_name)

    bot = BotConfig(
        id=bot_config.get("id", 0),
        name=bot_config.get("name", ""),
        shell_type=bot_config.get("shell_type", "Chat"),
        agent_config=bot_config.get("agent_config", {}),
        system_prompt=bot_config.get("system_prompt", ""),
        mcp_servers=bot_config.get("mcp_servers", []),
        skills=bot_config.get("skills", []),
    )

    attachments = []
    for att in kwargs.get("attachments", []):
        attachments.append(
            AttachmentInfo(
                id=att.get("id", 0),
                original_filename=att.get("original_filename", ""),
                file_extension=att.get("file_extension", ""),
                file_size=att.get("file_size", 0),
                mime_type=att.get("mime_type", ""),
                content=att.get("content"),
                data=att.get("data"),
            )
        )

    return WeGentChatRequest(
        subtask_id=subtask_id,
        task_id=task_id,
        user=user,
        bot=[bot],
        team_id=team_id,
        prompt=prompt,
        attachments=attachments,
        auth_token=kwargs.get("auth_token", ""),
        messages=kwargs.get("messages", []),
    )
