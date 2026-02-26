# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP Provider HTTP Client

Unified HTTP client for fetching server lists from MCP providers.
"""

import os
from typing import Any, Dict, Optional

import httpx

from app.schemas.mcp_provider_config import MCPProviderConfig
from shared.logger import setup_logger

logger = setup_logger("mcp_providers.http_client")


def _trust_env() -> bool:
    """Whether httpx should trust HTTP(S)_PROXY from environment."""
    return os.environ.get("MCP_PROVIDERS_TRUST_ENV", "").lower() in {"1", "true", "yes"}


class HTTPClientError(Exception):
    """HTTP client error"""

    def __init__(self, code: str, message: str = ""):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


class MCPProviderHTTPClient:
    """HTTP client for MCP providers"""

    def __init__(self, config: MCPProviderConfig):
        self.config = config
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client"""
        if self._client is None:
            timeout = httpx.Timeout(
                connect=10.0,
                read=self.config.api.timeout,
                write=10.0,
                pool=10.0,
            )
            self._client = httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=True,
                trust_env=_trust_env(),
            )
        return self._client

    async def close(self):
        """Close HTTP client"""
        if self._client:
            await self._client.aclose()
            self._client = None

    def _build_url(self, page: int = 1) -> str:
        """Build full URL with pagination"""
        url = f"{self.config.api.base_url}{self.config.api.list_path}"

        # Add query params
        params = dict(self.config.api.query_params or {})
        params[self.config.mapping.page_param] = page
        params[self.config.mapping.size_param] = self.config.mapping.page_size

        return url, params

    def _build_headers(self, token: str) -> Dict[str, str]:
        """Build request headers with auth"""
        headers = dict(self.config.api.headers or {})

        # Add auth header from template
        auth_header = self.config.api.auth_template.format(token=token)
        if "Authorization" not in headers:
            headers["Authorization"] = auth_header

        # Always set content type
        headers.setdefault("Content-Type", "application/json")

        return headers

    def _check_response(self, response: httpx.Response) -> Dict[str, Any]:
        """Check response and raise on error"""
        if response.status_code == 401:
            raise HTTPClientError("unauthorized", "Invalid or expired token")
        if response.status_code == 403:
            raise HTTPClientError("unauthorized", "Access forbidden")
        if response.status_code == 500:
            raise HTTPClientError("server_error", "Server error")
        if not response.is_success:
            raise HTTPClientError(
                f"http_error:{response.status_code}",
                response.text[:200],
            )

        data = response.json()

        # Check success field
        success_field = self.config.mapping.success_field
        if success_field and not data.get(success_field):
            error_msg = data.get(self.config.mapping.error_message_field, "API error")
            raise HTTPClientError("api_error", error_msg)

        return data

    async def fetch_all_servers(self, token: str) -> list[dict[str, Any]]:
        """Fetch all servers with pagination"""
        client = await self._get_client()
        all_items = []
        page = 1

        while True:
            url, params = self._build_url(page)
            headers = self._build_headers(token)

            logger.info(
                "Fetching servers from %s (page %d)",
                self.config.key,
                page,
            )

            response = await client.request(
                method=self.config.api.method,
                url=url,
                params=params if self.config.api.method == "GET" else None,
                json={} if self.config.api.method == "POST" else None,
                headers=headers,
            )

            data = self._check_response(response)

            # Extract items
            items = self._extract_by_path(data, self.config.mapping.items_path)
            if not items:
                break

            all_items.extend(items)

            # Check if more pages
            total = self._extract_by_path(data, self.config.mapping.total_path)
            if total is None:
                break

            if page * self.config.mapping.page_size >= total:
                break

            page += 1

        return all_items

    def _extract_by_path(self, data: dict, path: str) -> Any:
        """Extract value by dot-notation path with array index support"""
        if not path:
            return data

        # Support formats: "data", "data.result", "operational_urls[0].url"
        parts = path.replace("[", ".").replace("]", "").split(".")

        current = data
        for part in parts:
            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, list):
                try:
                    idx = int(part)
                    current = current[idx] if 0 <= idx < len(current) else None
                except (ValueError, IndexError):
                    return None
            else:
                return None

            if current is None:
                return None

        return current
