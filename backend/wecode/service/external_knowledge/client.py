# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""AP MCP JSON-RPC client for external knowledge."""

from itertools import count
from typing import Any

import httpx
import orjson

from wecode.config.external_knowledge_config import ExternalKnowledgeSettings
from wecode.service.external_knowledge.exceptions import (
    ExternalKnowledgeError,
    ExternalKnowledgeNotConfiguredError,
    map_provider_error,
)


class ApKnowledgeMcpClient:
    """JSON-RPC client for AP Streamable HTTP MCP tools."""

    _ids = count(1)

    def __init__(self, settings: ExternalKnowledgeSettings) -> None:
        self._settings = settings

    @property
    def configured(self) -> bool:
        """Return whether the AP service token is configured."""
        return bool(self._settings.AP_KNOWLEDGE_SYSTEM_TOKEN)

    async def health(self) -> bool:
        """Probe the AP health endpoint."""
        if not self.configured:
            return False
        try:
            async with httpx.AsyncClient(
                timeout=self._settings.AP_KNOWLEDGE_TIMEOUT
            ) as client:
                response = await client.get(
                    self._settings.ap_health_url,
                    headers=self._build_headers(employee_id="health-check"),
                )
                return 200 <= response.status_code < 300
        except httpx.HTTPError:
            return False

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        employee_id: str,
    ) -> dict[str, Any]:
        """Call an AP MCP tool and return parsed business data."""
        if not self.configured:
            raise ExternalKnowledgeNotConfiguredError(
                "AP knowledge system token is not configured"
            )

        payload = {
            "jsonrpc": "2.0",
            "id": next(self._ids),
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments,
            },
        }

        try:
            async with httpx.AsyncClient(
                timeout=self._settings.AP_KNOWLEDGE_TIMEOUT
            ) as client:
                response = await client.post(
                    self._settings.ap_mcp_url,
                    headers=self._build_headers(employee_id),
                    json=payload,
                )
                if response.status_code == 401:
                    raise map_provider_error(
                        "unauthorized", "AP knowledge authorization failed"
                    )
                response.raise_for_status()
                return self._parse_response(response.json())
        except ExternalKnowledgeError:
            raise
        except httpx.TimeoutException as exc:
            raise ExternalKnowledgeError(
                "AP knowledge request timed out",
                code="rate_limited",
                status_code=504,
            ) from exc
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            if status_code == 403:
                raise map_provider_error("forbidden", "AP knowledge access denied")
            if status_code == 404:
                raise map_provider_error("not_found", "AP knowledge resource not found")
            raise ExternalKnowledgeError(
                "AP knowledge service returned an error",
                code="internal_error",
                status_code=502,
            ) from exc
        except httpx.HTTPError as exc:
            raise ExternalKnowledgeError(
                "Failed to request AP knowledge service",
                code="internal_error",
                status_code=502,
            ) from exc

    def _build_headers(self, employee_id: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._settings.AP_KNOWLEDGE_SYSTEM_TOKEN}",
            "X-User-Name": employee_id,
            "Content-Type": "application/json",
        }

    def _parse_response(self, data: dict[str, Any]) -> dict[str, Any]:
        if "error" in data:
            error = data.get("error") or {}
            raise map_provider_error(
                str(error.get("code") or "internal_error"),
                str(error.get("message") or error.get("error") or "MCP call failed"),
            )

        result = data.get("result") or {}
        content = result.get("content") or []
        text = ""
        if content and isinstance(content[0], dict):
            text = str(content[0].get("text") or "")

        parsed = self._parse_text_payload(text)
        if result.get("isError") is True:
            raise map_provider_error(
                str(parsed.get("code") or "internal_error"),
                str(parsed.get("error") or parsed.get("message") or "MCP tool failed"),
            )
        return parsed

    @staticmethod
    def _parse_text_payload(text: str) -> dict[str, Any]:
        try:
            parsed = orjson.loads(text)
        except orjson.JSONDecodeError as exc:
            raise ExternalKnowledgeError(
                "AP knowledge response payload is invalid JSON",
                code="internal_error",
                status_code=502,
            ) from exc
        if not isinstance(parsed, dict):
            raise ExternalKnowledgeError(
                "AP knowledge response payload is not an object",
                code="internal_error",
                status_code=502,
            )
        return parsed
