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

# Agent
from .agent import AgentConfig, ChatAgent, chat_agent

# Agents
from .agents import LangGraphAgentBuilder

# Boundary contracts
from .api.schemas import ChatEvent, ChatEventType, StreamEvent, StreamEventType

# Messages
from .messages import MessageConverter

# Models
from .models import LangChainModelFactory

# Skills
from .skills import SkillToolContext, SkillToolProvider, SkillToolRegistry

# Streaming
from .streaming import SSEStreamingHandler

# Tools
from .tools import (
    FileListSkill,
    FileReaderSkill,
    KnowledgeBaseTool,
    ToolRegistry,
    WebSearchTool,
    global_registry,
)

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
