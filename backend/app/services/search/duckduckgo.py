# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DuckDuckGo search service implementation.
"""

import logging
from typing import List, Dict, Any
import asyncio
from duckduckgo_search import DDGS

from .base import SearchServiceBase

logger = logging.getLogger(__name__)


class DuckDuckGoSearchService(SearchServiceBase):
    """
    DuckDuckGo search implementation using duckduckgo_search library.

    This service provides privacy-focused web search without requiring API keys.
    """

    def __init__(self):
        """Initialize DuckDuckGo search service."""
        self.ddgs = DDGS()

    async def search(self, query: str, limit: int = 5) -> str:
        """
        Perform a DuckDuckGo search and return formatted results.

        Args:
            query: The search query string
            limit: Maximum number of results to return (default: 5)

        Returns:
            Formatted search results as a string suitable for LLM context
        """
        try:
            results = await self.search_raw(query, limit)
            return self.format_results_for_llm(results)
        except Exception as e:
            logger.error(f"DuckDuckGo search failed for query '{query}': {e}")
            return f"Search failed: {str(e)}"

    async def search_raw(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """
        Perform a DuckDuckGo search and return raw results.

        Args:
            query: The search query string
            limit: Maximum number of results to return (default: 5)

        Returns:
            List of search result dictionaries
        """
        try:
            # Run blocking search in thread pool to avoid blocking event loop
            loop = asyncio.get_event_loop()
            results = await loop.run_in_executor(
                None, lambda: list(self.ddgs.text(query, max_results=limit))
            )

            # Transform results to consistent format
            formatted_results = []
            for result in results:
                formatted_results.append(
                    {
                        "title": result.get("title", ""),
                        "url": result.get("href", ""),
                        "snippet": result.get("body", ""),
                    }
                )

            logger.info(
                f"DuckDuckGo search successful for query '{query}': {len(formatted_results)} results"
            )
            return formatted_results

        except Exception as e:
            logger.error(f"DuckDuckGo search failed for query '{query}': {e}")
            raise Exception(f"DuckDuckGo search error: {str(e)}")
