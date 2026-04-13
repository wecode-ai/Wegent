# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Web fetch tool for making HTTP requests.

Provides the WebFetchTool that allows AI agents to make HTTP requests
with custom headers. This is essential for two-step download flows
(e.g., DingTalk document download) where an MCP tool returns a URL
and the agent must perform the actual HTTP GET.
"""

import base64
import json
import logging
from typing import Optional

import httpx
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Limits
MAX_RESPONSE_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_TEXT_PREVIEW = 50_000  # 50K chars for text responses
DEFAULT_TIMEOUT = 30.0  # seconds

# Content types considered as text
TEXT_CONTENT_TYPES = {
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-yaml",
    "application/yaml",
    "application/xhtml+xml",
    "application/svg+xml",
}


def _is_text_content_type(content_type: str) -> bool:
    """Check if the content type is text-based."""
    ct_lower = content_type.lower()
    return any(ct_lower.startswith(t) for t in TEXT_CONTENT_TYPES)


class WebFetchInput(BaseModel):
    """Input schema for the web fetch tool."""

    url: str = Field(description="The URL to fetch")
    method: str = Field(
        default="GET",
        description="HTTP method (GET or POST)",
    )
    headers: Optional[dict[str, str]] = Field(
        default=None,
        description="Custom HTTP headers as key-value pairs",
    )
    body: Optional[str] = Field(
        default=None,
        description="Request body for POST requests",
    )
    timeout: Optional[float] = Field(
        default=None,
        description="Request timeout in seconds (default: 30)",
    )


class WebFetchTool(BaseTool):
    """Fetch content from a URL with custom headers.

    Makes HTTP GET or POST requests and returns the response content.
    For text responses, returns the content directly.
    For binary responses, returns base64-encoded content with metadata.

    This tool enables two-step download flows where an MCP tool
    (e.g., DingTalk download_file) returns a URL and headers,
    and the agent needs to perform the actual HTTP request.
    """

    name: str = "web_fetch"
    display_name: str = "Web Fetch"
    description: str = (
        "Fetch content from a URL using HTTP GET or POST. "
        "Supports custom headers for authenticated requests. "
        "Returns text content directly or base64-encoded binary data. "
        "Use this when you need to download files or fetch web content "
        "with specific headers (e.g., after getting download credentials "
        "from an MCP tool)."
    )
    args_schema: type[BaseModel] = WebFetchInput

    def _run(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[dict[str, str]] = None,
        body: Optional[str] = None,
        timeout: Optional[float] = None,
        **_,
    ) -> str:
        """Synchronous execution (delegates to async)."""
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            # Running inside an event loop, use sync httpx
            return self._run_sync(url, method, headers, body, timeout)
        return asyncio.run(self._arun(url, method, headers, body, timeout))

    def _run_sync(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[dict[str, str]] = None,
        body: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> str:
        """Synchronous HTTP request."""
        effective_timeout = timeout or DEFAULT_TIMEOUT
        method_upper = method.upper()

        if method_upper not in ("GET", "POST"):
            return json.dumps({"error": "Only GET and POST methods are supported"})

        try:
            with httpx.Client(
                timeout=effective_timeout,
                follow_redirects=True,
                max_redirects=5,
            ) as client:
                if method_upper == "POST":
                    response = client.post(
                        url,
                        headers=headers,
                        content=body.encode("utf-8") if body else None,
                    )
                else:
                    response = client.get(url, headers=headers)

            return self._format_response(response, url)

        except httpx.TimeoutException:
            return json.dumps(
                {"error": f"Request timed out after {effective_timeout}s"}
            )
        except httpx.TooManyRedirects:
            return json.dumps({"error": "Too many redirects"})
        except Exception as e:
            logger.warning("[WebFetchTool] Request failed: url=%s error=%s", url, e)
            return json.dumps({"error": f"Request failed: {str(e)}"})

    async def _arun(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[dict[str, str]] = None,
        body: Optional[str] = None,
        timeout: Optional[float] = None,
        **_,
    ) -> str:
        """Async HTTP request."""
        effective_timeout = timeout or DEFAULT_TIMEOUT
        method_upper = method.upper()

        if method_upper not in ("GET", "POST"):
            return json.dumps({"error": "Only GET and POST methods are supported"})

        try:
            async with httpx.AsyncClient(
                timeout=effective_timeout,
                follow_redirects=True,
                max_redirects=5,
            ) as client:
                if method_upper == "POST":
                    response = await client.post(
                        url,
                        headers=headers,
                        content=body.encode("utf-8") if body else None,
                    )
                else:
                    response = await client.get(url, headers=headers)

            return self._format_response(response, url)

        except httpx.TimeoutException:
            return json.dumps(
                {"error": f"Request timed out after {effective_timeout}s"}
            )
        except httpx.TooManyRedirects:
            return json.dumps({"error": "Too many redirects"})
        except Exception as e:
            logger.warning("[WebFetchTool] Request failed: url=%s error=%s", url, e)
            return json.dumps({"error": f"Request failed: {str(e)}"})

    def _format_response(self, response: httpx.Response, url: str) -> str:
        """Format HTTP response for LLM consumption."""
        status_code = response.status_code
        content_type = response.headers.get("content-type", "")
        content_length = len(response.content)

        if status_code >= 400:
            error_body = ""
            try:
                error_body = response.text[:1000]
            except Exception:
                pass
            return json.dumps(
                {
                    "error": f"HTTP {status_code}",
                    "status_code": status_code,
                    "body_preview": error_body,
                },
                ensure_ascii=False,
            )

        if content_length > MAX_RESPONSE_SIZE:
            return json.dumps(
                {
                    "error": f"Response too large: {content_length} bytes (max {MAX_RESPONSE_SIZE})",
                    "status_code": status_code,
                    "content_type": content_type,
                    "content_length": content_length,
                }
            )

        # Text response
        if _is_text_content_type(content_type):
            text = response.text
            truncated = len(text) > MAX_TEXT_PREVIEW
            return json.dumps(
                {
                    "status_code": status_code,
                    "content_type": content_type,
                    "content": text[:MAX_TEXT_PREVIEW],
                    "truncated": truncated,
                    "content_length": content_length,
                },
                ensure_ascii=False,
            )

        # Binary response - return base64
        encoded = base64.b64encode(response.content).decode("ascii")
        return json.dumps(
            {
                "status_code": status_code,
                "content_type": content_type,
                "content_base64": encoded,
                "content_length": content_length,
                "encoding": "base64",
            }
        )
