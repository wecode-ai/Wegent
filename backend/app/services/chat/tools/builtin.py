# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Built-in tools for Chat Shell.

This module provides built-in tools like web search.
"""

import logging

from app.services.chat.tools.base import Tool
from app.services.search import get_search_service

logger = logging.getLogger(__name__)


def get_web_search_tool(engine_name: str | None = None) -> Tool | None:
    """
    Get a web search tool instance.

    Args:
        engine_name: Optional search engine name to use

    Returns:
        Tool instance, or None if search service not available
    """
    search_service = get_search_service(engine_name=engine_name)
    if not search_service:
        return None

    return Tool(
        name="search",
        description="Search the web for information. Returns search results with titles, URLs, and snippets.",
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query string",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 5)",
                    "default": 5,
                },
            },
            "required": ["query"],
        },
        fn=search_service.search,
    )
