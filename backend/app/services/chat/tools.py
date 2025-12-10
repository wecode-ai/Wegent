# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat service tools definition using FastMCP pattern.
"""

from fastmcp import FastMCP

from app.services.search import get_search_service


def get_web_search_mcp(engine_name: str | None = None) -> FastMCP | None:
    """
    Get a web search tool instance.
    return FastMCP(web_search, search_engine=search_engine)
    """
    search_service = get_search_service(engine_name=engine_name)
    if not search_service:
        return None

    mcp = FastMCP()
    mcp.tool(search_service.search)
    return mcp
