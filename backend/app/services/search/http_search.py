# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Generic HTTP-based web search service implementation.

This implementation uses HTTP API calls with configurable parameters,
making it compatible with various search engines including DuckDuckGo,
SearXNG, and custom search APIs.
"""

import logging
from typing import Any
import httpx

from .base import SearchServiceBase

logger = logging.getLogger(__name__)


class HttpSearchService(SearchServiceBase):
    """
    Generic HTTP-based search service.

    Configuration example for DuckDuckGo-compatible API:
    {
        "base_url": "https://api.duckduckgo.com/",
        "query_param": "q",
        "limit_param": "max_results",
        "format_param": "format",
        "format_value": "json",
        "response_path": "RelatedTopics",
        "title_field": "Text",
        "url_field": "FirstURL",
        "snippet_field": "Text"
    }
    """

    def __init__(
        self,
        base_url: str,
        query_param: str = "q",
        limit_param: str | None = "limit",
        auth_header: dict[str, str] | None = None,
        extra_params: dict[str, str] | None = None,
        response_path: str | None = None,
        title_field: str = "title",
        url_field: str = "url",
        snippet_field: str = "snippet",
        content_field: str = "content",
        timeout: int = 10,
    ):
        """
        Initialize HTTP search service.

        Args:
            base_url: API endpoint URL
            query_param: Query string parameter name (default: "q")
            limit_param: Results limit parameter name (default: "limit", None to disable)
            auth_header: Authentication headers (e.g., {"Authorization": "Bearer token"})
            extra_params: Additional query parameters to include in every request
            response_path: JSONPath to results array (e.g., "data.results", None for root)
            title_field: Field name for result title
            url_field: Field name for result URL
            snippet_field: Field name for result snippet/description
            content_field: Field name for result main content
            timeout: Request timeout in seconds
        """
        self.base_url = base_url.rstrip("/")
        self.query_param = query_param
        self.limit_param = limit_param
        self.auth_header = auth_header or {}
        self.extra_params = extra_params or {}
        self.response_path = response_path
        self.title_field = title_field
        self.url_field = url_field
        self.snippet_field = snippet_field
        self.content_field = content_field
        self.timeout = timeout

    def _extract_results(self, response_data: Any) -> list[dict[str, Any]]:
        """
        Extract results array from response using configured path.

        Args:
            response_data: JSON response data

        Returns:
            list of result dictionaries
        """
        if not self.response_path:
            # Response is the results array itself
            if isinstance(response_data, list):
                return response_data
            return []

        # Navigate through nested path (e.g., "data.results")
        current = response_data
        for key in self.response_path.split("."):
            if isinstance(current, dict):
                current = current.get(key)
            else:
                return []

            if current is None:
                return []

        if isinstance(current, list):
            return current
        return []

    async def search(self, query: str, limit: int = 5) -> str:
        """
        Perform a web search and return formatted results.

        Args:
            query: The search query string
            limit: Maximum number of results to return (default: 5)

        Returns:
            Formatted search results as a string suitable for LLM context
        """
        if not query:
            return ""
        try:
            results = await self.search_raw(query, limit)
            results_for_llm = self.format_results_for_llm(results[:limit])
            logger.info("results_for_llm: %s", results_for_llm)
            return results_for_llm
        except Exception as e:
            logger.exception("HTTP search failed for query '%s'", query)
            return f"Search failed: {str(e)}"

    async def search_raw(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """
        Perform a web search and return raw results.

        Args:
            query: The search query string
            limit: Maximum number of results to return (default: 5)

        Returns:
            list of search result dictionaries
        """
        try:
            # Build query parameters
            params = {self.query_param: query}

            # Add limit parameter if configured
            if self.limit_param:
                params[self.limit_param] = limit

            # Add extra parameters
            params.update(self.extra_params)

            # Make HTTP request
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    self.base_url,
                    params=params,
                    headers=self.auth_header,
                    timeout=self.timeout,
                )
                response.raise_for_status()
                data = response.json()

            # Extract results array
            raw_results = self._extract_results(data)

            # Transform to standard format
            formatted_results = []
            for item in raw_results[:limit]:
                if not isinstance(item, dict):
                    continue

                formatted_results.append(
                    {
                        "title": str(item.get(self.title_field, "")).strip(),
                        "url": str(item.get(self.url_field, "")).strip(),
                        "snippet": str(item.get(self.snippet_field, "")).strip(),
                        "content": str(item.get(self.content_field, "")).strip(),
                    }
                )

            logger.info(
                "HTTP search successful for query '%s': %s results",
                query,
                len(formatted_results),
            )
            return formatted_results

        except httpx.HTTPStatusError as e:
            logger.exception(
                "HTTP search failed with status %s",
                e.response.status_code,
            )
            raise Exception(f"Search API returned error: {e.response.status_code}") from e
        except Exception as e:
            logger.exception("HTTP search failed for query '%s'", query)
            raise Exception(f"Search error: {e!s}") from e
