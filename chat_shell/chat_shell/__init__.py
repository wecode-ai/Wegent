# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell module - LangGraph-based AI chat agent.

This module provides the full chat_shell implementation for the Chat Shell
microservice. It includes:

- ChatAgent: Main agent class for chat completions
- AgentConfig: Configuration dataclass for agent creation
- LangGraphAgentBuilder: LangGraph agent builder with ReAct workflow
- Tool registry and built-in tools
- Message compression and history management
- MCP (Model Context Protocol) integration
- Skill system for dynamic tool loading
- Storage abstraction (Memory, SQLite, Remote)
- /v1/response API with SSE streaming

Deployment Modes:
    1. HTTP Mode (default): Independent HTTP service with /v1/response API
       - Backend calls chat_shell's HTTP API
       - Storage: remote (calls Backend's /internal/chat/* APIs)

    2. Package Mode: Backend imports chat_shell directly
       - Backend passes messages directly, no storage needed
       - More efficient, no HTTP overhead

    3. CLI Mode: Command-line interface for developers
       - Storage: sqlite (local persistence)

Environment Variables:
    CHAT_SHELL_MODE: "http" | "package" | "cli" (default: "http")
    CHAT_SHELL_STORAGE_TYPE: "memory" | "sqlite" | "remote" (default: "remote")
    CHAT_SHELL_REMOTE_STORAGE_URL: Backend internal API URL
    CHAT_SHELL_REMOTE_STORAGE_TOKEN: Internal service token
    CHAT_SHELL_HTTP_PORT: HTTP server port (default: 8001)

HTTP Mode Usage:
    # Start server
    chat-shell serve --port 8001

    # Or with uvicorn
    uvicorn chat_shell.main:app --host 0.0.0.0 --port 8001

Package Mode Usage:
    from chat_shell import ChatAgent, AgentConfig, create_chat_agent

    # Create agent
    agent = create_chat_agent()

    # Build configuration
    config = AgentConfig(
        model_config={"model": "claude-3-5-sonnet-20241022", "api_key": "..."},
        system_prompt="You are a helpful assistant.",
    )

    # Stream responses (messages include full history)
    messages = [
        {"role": "user", "content": "Hello!"},
    ]
    async for event in agent.stream(messages, config):
        if event["type"] == "content":
            print(event["data"]["text"], end="", flush=True)

CLI Usage:
    # Interactive chat
    chat-shell chat --model claude-3-5-sonnet

    # Single query
    chat-shell query "What is Python?"

    # Configuration
    chat-shell config set api_keys.claude sk-ant-xxxxx
"""

__version__ = "1.0.0"

from .agent import AgentConfig, ChatAgent, create_chat_agent

__all__ = [
    "__version__",
    "AgentConfig",
    "ChatAgent",
    "create_chat_agent",
]
