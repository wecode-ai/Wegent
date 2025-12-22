"""Web search tool integrated with backend search service."""

from typing import Optional

from pydantic import Field

from ..base import BaseTool, ToolInput, ToolResult


class WebSearchInput(ToolInput):
    """Input schema for web search tool."""

    query: str = Field(description="Search query")
    max_results: int = Field(default=5, description="Maximum number of results")


class WebSearchTool(BaseTool):
    """Web search tool that integrates with backend search service."""

    name = "web_search"
    description = "Search the web for information. Returns a list of relevant web pages with titles, URLs, and snippets."
    input_schema = WebSearchInput

    def __init__(self, timeout: int = 30):
        """Initialize web search tool.

        Args:
            timeout: Execution timeout
        """
        super().__init__(timeout)

    async def execute(self, query: str, max_results: int = 5) -> ToolResult:
        """Execute web search.

        Args:
            query: Search query
            max_results: Maximum number of results

        Returns:
            ToolResult with search results
        """
        try:
            # Import search service
            from app.services.search import get_search_service

            # Get search service instance
            search_service = get_search_service()
            if not search_service:
                return ToolResult(
                    success=False,
                    output=None,
                    error="Web search service not configured. Set WEB_SEARCH_ENABLED=true and configure WEB_SEARCH_ENGINES.",
                )

            # Execute search
            results = await search_service.search(query=query, max_results=max_results)

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

            return ToolResult(
                success=True,
                output={
                    "query": query,
                    "results": formatted_results,
                    "count": len(formatted_results),
                },
                metadata={"max_results": max_results},
            )

        except Exception as e:
            return ToolResult(
                success=False, output=None, error=f"Web search failed: {str(e)}"
            )
