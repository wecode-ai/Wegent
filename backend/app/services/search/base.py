# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base interface for web search services.
"""

import logging
from abc import ABC, abstractmethod
from typing import Any

logger = logging.getLogger(__name__)


class SearchServiceBase(ABC):
    """
    Base class for web search service implementations.

    This interface allows for easy integration of different search engines
    (DuckDuckGo, Google, Bing, etc.) by implementing the search method.
    """

    async def search(self, query: str, limit: int = 5) -> str:
        """
        Perform a web search and return formatted results as text.

        Args:
            query: The search query string
            limit: Maximum number of results to return (default: 5)

        Returns:
            Formatted search results as a string suitable for LLM context.
            Should include titles, URLs, and snippets in a readable format.

        Raises:
            Exception: If the search fails
        """
        if not query:
            return ""
        try:
            results = await self.search_raw(query, limit)
            results_for_llm = self.format_results_for_llm(results)
            logger.info("results_for_llm: %s", results_for_llm)
            return results_for_llm
        except Exception as e:
            logger.exception("Search failed for query '%s'", query)
            return f"Search failed: {str(e)}"

    @abstractmethod
    async def search_raw(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """
        Perform a web search and return raw results.

        Args:
            query: The search query string
            limit: Maximum number of results to return (default: 5)

        Returns:
            list of search result dictionaries with keys like:
            - title: Result title
            - url: Result URL
            - snippet: Result description/snippet

        Raises:
            Exception: If the search fails
        """
        pass

    def format_results_for_llm(self, results: list[dict[str, Any]]) -> str:
        """
        Format raw search results into a readable string for LLM context.

        Args:
            results: list of search result dictionaries

        Returns:
            Formatted string with search results
        """
        if not results:
            return "No search results found."

        formatted = "Search Results:\n\n"
        for idx, result in enumerate(results, 1):
            title = result.get("title", "No title")
            url = result.get("url", "")
            snippet = result.get("snippet", "No description available")
            content = result.get("content", "No description available")

            formatted += f"{idx}. {title}\n"
            formatted += f"- URL: {url}\n"
            formatted += f"- snippet: {snippet}\n"
            formatted += f"\n```txt\n{content}\n```\n\n"

        return formatted.strip()
