# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell Service - LLM Direct Conversation Service.

This package provides core functionality for Chat Shell type tasks:
- LLM conversation management
- Streaming response handling
- Tool call execution
- Session state management

Chat Shell is a Shell type, similar to Claude Code, Agno, Dify, etc.
It can be embedded in Backend or deployed independently in the future.
"""


def __getattr__(name: str):
    """Lazy import to avoid loading heavy dependencies when not needed.

    This allows submodules like compression to be imported without
    triggering the full import chain (e.g., langgraph).
    """
    # Agent
    if name in ("AgentConfig", "ChatAgent", "chat_agent"):
        from .agent import AgentConfig, ChatAgent, chat_agent

        return {
            "AgentConfig": AgentConfig,
            "ChatAgent": ChatAgent,
            "chat_agent": chat_agent,
        }[name]

    # Agents
    if name == "LangGraphAgentBuilder":
        from .agents import LangGraphAgentBuilder

        return LangGraphAgentBuilder

    # Boundary contracts
    if name in ("ChatEvent", "ChatEventType", "StreamEvent", "StreamEventType"):
        from .api.schemas import ChatEvent, ChatEventType, StreamEvent, StreamEventType

        return {
            "ChatEvent": ChatEvent,
            "ChatEventType": ChatEventType,
            "StreamEvent": StreamEvent,
            "StreamEventType": StreamEventType,
        }[name]

    # Messages
    if name == "MessageConverter":
        from .messages import MessageConverter

        return MessageConverter

    # Models
    if name == "LangChainModelFactory":
        from .models import LangChainModelFactory

        return LangChainModelFactory

    # Skills
    if name in ("SkillToolContext", "SkillToolProvider", "SkillToolRegistry"):
        from .skills import SkillToolContext, SkillToolProvider, SkillToolRegistry

        return {
            "SkillToolContext": SkillToolContext,
            "SkillToolProvider": SkillToolProvider,
            "SkillToolRegistry": SkillToolRegistry,
        }[name]

    # Streaming
    if name == "SSEStreamingHandler":
        from .streaming import SSEStreamingHandler

        return SSEStreamingHandler

    # Tools
    if name in (
        "FileListSkill",
        "FileReaderSkill",
        "KnowledgeBaseTool",
        "ToolRegistry",
        "WebSearchTool",
        "global_registry",
    ):
        from .tools import (
            FileListSkill,
            FileReaderSkill,
            KnowledgeBaseTool,
            ToolRegistry,
            WebSearchTool,
            global_registry,
        )

        return {
            "FileListSkill": FileListSkill,
            "FileReaderSkill": FileReaderSkill,
            "KnowledgeBaseTool": KnowledgeBaseTool,
            "ToolRegistry": ToolRegistry,
            "WebSearchTool": WebSearchTool,
            "global_registry": global_registry,
        }[name]

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    # Boundary contracts
    "ChatEvent",
    "ChatEventType",
    "StreamEvent",
    "StreamEventType",
    # Agent
    "ChatAgent",
    "chat_agent",
    "AgentConfig",
    # Agents
    "LangGraphAgentBuilder",
    # Messages
    "MessageConverter",
    # Models
    "LangChainModelFactory",
    # Streaming
    "SSEStreamingHandler",
    # Tools
    "ToolRegistry",
    "global_registry",
    "WebSearchTool",
    "KnowledgeBaseTool",
    "FileReaderSkill",
    "FileListSkill",
    # Skills
    "SkillToolContext",
    "SkillToolProvider",
    "SkillToolRegistry",
]
