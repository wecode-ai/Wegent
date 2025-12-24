# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Web search tool integrated with backend search service."""

import json

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


class WebSearchInput(BaseModel):
    """Input schema for web search tool."""

    query: str = Field(description="Search query")
    max_results: int = Field(default=5, description="Maximum number of results")


class WebSearchTool(BaseTool):
    """Web search tool that integrates with backend search service."""

    name: str = "web_search"
    description: str = (
        "Search the web for information. Returns a list of relevant web pages with titles, URLs, and snippets."
    )
    args_schema: type[BaseModel] = WebSearchInput

    # Optional: specify which search engine to use (None = use first available)
    engine_name: str | None = None

    def _run(
        self,
        query: str,
        max_results: int = 5,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("WebSearchTool only supports async execution")

    async def _arun(
        self,
        query: str,
        max_results: int = 5,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute web search asynchronously.

        Args:
            query: Search query
            max_results: Maximum number of results
            run_manager: Callback manager

        Returns:
            JSON string with search results
        """
        try:
            # Import search service
            from app.services.search import get_search_service

            # Get search service instance (use specified engine or default to first)
            search_service = get_search_service(self.engine_name)
            if not search_service:
                return json.dumps(
                    {
                        "error": "Web search service not configured. Set WEB_SEARCH_ENABLED=true and configure WEB_SEARCH_ENGINES."
                    }
                )

            # Execute search using search_raw to get list of results
            # (search() returns formatted string, search_raw() returns list)
            results = await search_service.search_raw(query=query, limit=max_results)

            # Format results
            formatted_results = []
            for result in results:
                formatted_results.append(
                    {
                        "title": result.get("title", ""),
                        "url": result.get("url", ""),
                        "snippet": result.get("snippet", ""),
                        "content": result.get("content", ""),
                    }
                )

            return json.dumps(
                {
                    "query": query,
                    "results": formatted_results,
                    "count": len(formatted_results),
                },
                ensure_ascii=False,
            )

        except Exception as e:
            return json.dumps({"error": f"Web search failed: {str(e)}"})
