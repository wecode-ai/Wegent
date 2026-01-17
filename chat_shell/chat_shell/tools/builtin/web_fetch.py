# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Web fetch tool for retrieving and parsing web page content.

This tool allows the AI agent to fetch web pages and convert them to markdown,
useful for getting the latest content from web sources.
"""

import json
import logging
from typing import Any

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class WebFetchInput(BaseModel):
    """Input schema for web fetch tool."""

    url: str = Field(description="The URL of the web page to fetch")


class WebFetchTool(BaseTool):
    """Tool for fetching web page content and converting to markdown.

    This tool is useful when:
    - Knowledge base contains web documents that might be outdated
    - User needs the latest content from a web page
    - AI needs to extract information from a new web URL

    In package mode (running inside backend), uses the web scraper service directly.
    In HTTP mode (standalone), makes HTTP calls to the backend API.
    """

    name: str = "web_fetch"
    display_name: str = "获取网页内容"
    description: str = (
        "Fetch and extract content from a web page URL. "
        "Returns the page content in markdown format. "
        "Use this when you need to get the latest content from a web page, "
        "or when knowledge base web documents might be outdated."
    )
    args_schema: type[BaseModel] = WebFetchInput

    # Backend API URL for HTTP mode (optional)
    backend_url: str | None = None

    def _run(
        self,
        url: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("WebFetchTool only supports async execution")

    async def _arun(
        self,
        url: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Fetch and parse a web page asynchronously.

        Args:
            url: The URL to fetch
            run_manager: Callback manager

        Returns:
            JSON string with page content and metadata
        """
        try:
            # Try to use backend web scraper service (package mode)
            return await self._fetch_via_backend(url)
        except ImportError:
            # Fall back to HTTP API (HTTP mode)
            return await self._fetch_via_http(url)

    async def _fetch_via_backend(self, url: str) -> str:
        """Fetch using backend's web scraper service (package mode).

        Args:
            url: The URL to fetch

        Returns:
            JSON string with scraped content
        """
        from app.services.web_scraper import get_web_scraper_service

        service = get_web_scraper_service()
        result = await service.scrape_url(url)

        if not result.success:
            return json.dumps(
                {
                    "success": False,
                    "error": result.error_message or "Failed to fetch web page",
                    "error_code": result.error_code,
                    "url": url,
                },
                ensure_ascii=False,
            )

        return json.dumps(
            {
                "success": True,
                "url": result.url,
                "title": result.title,
                "content": result.content,
                "content_length": result.content_length,
                "description": result.description,
                "scraped_at": result.scraped_at.isoformat(),
            },
            ensure_ascii=False,
        )

    async def _fetch_via_http(self, url: str) -> str:
        """Fetch via HTTP call to backend API (HTTP mode).

        Args:
            url: The URL to fetch

        Returns:
            JSON string with scraped content
        """
        import httpx

        from chat_shell.core.config import settings

        # Determine backend URL
        backend_url = self.backend_url or getattr(settings, "BACKEND_URL", None)
        if not backend_url:
            return json.dumps(
                {
                    "success": False,
                    "error": "Backend URL not configured for web fetch",
                    "url": url,
                }
            )

        api_endpoint = f"{backend_url.rstrip('/')}/api/web-scraper/scrape"

        logger.info(f"[WebFetchTool] Fetching via HTTP: {url}")

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    api_endpoint,
                    json={"url": url},
                    headers={"Content-Type": "application/json"},
                )

                if response.status_code != 200:
                    logger.warning(
                        f"[WebFetchTool] API returned {response.status_code}: {response.text[:200]}"
                    )
                    return json.dumps(
                        {
                            "success": False,
                            "error": f"API returned status {response.status_code}",
                            "url": url,
                        }
                    )

                data = response.json()

                if not data.get("success", True):
                    return json.dumps(
                        {
                            "success": False,
                            "error": data.get("error_message", "Unknown error"),
                            "error_code": data.get("error_code"),
                            "url": url,
                        },
                        ensure_ascii=False,
                    )

                return json.dumps(
                    {
                        "success": True,
                        "url": data.get("url", url),
                        "title": data.get("title"),
                        "content": data.get("content", ""),
                        "content_length": data.get("content_length", 0),
                        "description": data.get("description"),
                        "scraped_at": data.get("scraped_at"),
                    },
                    ensure_ascii=False,
                )

        except httpx.TimeoutException:
            logger.error(f"[WebFetchTool] Timeout fetching {url}")
            return json.dumps(
                {
                    "success": False,
                    "error": "Request timed out",
                    "url": url,
                }
            )
        except Exception as e:
            logger.error(f"[WebFetchTool] HTTP fetch failed: {e}", exc_info=True)
            return json.dumps(
                {
                    "success": False,
                    "error": f"Failed to fetch: {str(e)}",
                    "url": url,
                }
            )
