# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP Server tools module.

Contains tools for:
- System MCP (silent_exit)
- Knowledge MCP (list_knowledge_bases, list_documents, create_knowledge_base,
  create_document, update_document_content)
- KB Retrieval MCP (knowledge_base_search, kb_ls, kb_head)

Knowledge MCP tools are implemented independently using the KnowledgeOrchestrator
service layer, with Celery-based async task scheduling for indexing and summary.

KB Retrieval MCP tools provide read-only access to knowledge base content,
equivalent to chat_shell's LangChain tools but exposed via MCP for executor agents.

Tools are declared using @mcp_tool decorator which provides:
- Automatic parameter schema extraction
- token_info auto-injection from MCP context
- Custom name/description support
- Parameter filtering (token_info is hidden from MCP schema)
"""

from .decorator import (
    build_mcp_tools_dict,
    clear_tools_registry,
    get_registered_mcp_tools,
    mcp_tool,
)
from .kb_retrieval import KB_RETRIEVAL_MCP_TOOLS
from .knowledge import KNOWLEDGE_MCP_TOOLS
from .silent_exit import silent_exit

__all__ = [
    "silent_exit",
    "KNOWLEDGE_MCP_TOOLS",
    "KB_RETRIEVAL_MCP_TOOLS",
    "mcp_tool",
    "get_registered_mcp_tools",
    "build_mcp_tools_dict",
    "clear_tools_registry",
]
