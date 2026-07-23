# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Small protocol adapter for the DingTalk Docs MCP service."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

MCP_TOOL_LIST_NODES = "list_nodes"
MCP_TOOL_SEARCH_DOCUMENTS = "search_documents"
MCP_TOOL_GET_DOCUMENT_CONTENT = "get_document_content"

DEFAULT_PAGE_SIZE = 10
MCP_REQUEST_TIMEOUT_SECONDS = 15
MCP_SSE_READ_TIMEOUT_SECONDS = 30


class DingTalkMcpError(RuntimeError):
    """Safe, classified error raised by the DingTalk MCP adapter."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message


@dataclass(frozen=True)
class DingTalkNodePage:
    """A bounded page returned by ``list_nodes``."""

    nodes: list[dict[str, Any]]
    has_more: bool
    next_page_token: str | None


@dataclass(frozen=True)
class DingTalkSearchPage:
    """A bounded page returned by ``search_documents``."""

    documents: list[dict[str, Any]]
    has_more: bool
    next_page_token: str | None


@dataclass(frozen=True)
class DingTalkDocumentContent:
    """Normalized document content returned by ``get_document_content``."""

    markdown: str
    title: str
    node_id: str
    doc_url: str | None


class DingTalkDocsMcpClient:
    """Call the current DingTalk Docs MCP tool contract."""

    def __init__(
        self,
        url: str,
        *,
        timeout_seconds: float = MCP_REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self._url = url
        self._timeout_seconds = timeout_seconds

    async def list_nodes(
        self,
        *,
        workspace_id: str | None = None,
        folder_id: str | None = None,
        page_token: str | None = None,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> DingTalkNodePage:
        """List a bounded page of nodes for directory synchronization."""
        arguments: dict[str, Any] = {"pageSize": page_size}
        if workspace_id:
            arguments["workspaceId"] = workspace_id
        if folder_id:
            arguments["folderId"] = folder_id
        if page_token:
            arguments["pageToken"] = page_token
        payload = await self._call_tool(MCP_TOOL_LIST_NODES, arguments)
        nodes = _extract_list(payload, ("nodes", "items", "documents"))
        if nodes is None:
            raise DingTalkMcpError(
                "invalid_response", "DingTalk Docs MCP returned an invalid node list"
            )
        return DingTalkNodePage(
            nodes=nodes,
            has_more=_as_bool(payload, "hasMore", "has_more"),
            next_page_token=_as_string(payload, "nextPageToken", "next_page_token"),
        )

    async def search_documents(
        self,
        *,
        keyword: str,
        workspace_ids: list[str] | None,
        extensions: list[str] | None = None,
        page_token: str | None = None,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> DingTalkSearchPage:
        """Search document metadata using the current Docs MCP schema."""
        arguments: dict[str, Any] = {
            "keyword": keyword,
            "pageSize": page_size,
        }
        if workspace_ids:
            arguments["workspaceIds"] = workspace_ids
        if extensions:
            arguments["extensions"] = extensions
        if page_token:
            arguments["pageToken"] = page_token
        payload = await self._call_tool(MCP_TOOL_SEARCH_DOCUMENTS, arguments)
        documents = _extract_list(payload, ("documents", "items", "records"))
        if documents is None:
            raise DingTalkMcpError(
                "invalid_response",
                "DingTalk Docs MCP returned an invalid document search response",
            )
        return DingTalkSearchPage(
            documents=documents,
            has_more=_as_bool(payload, "hasMore", "has_more"),
            next_page_token=_as_string(payload, "nextPageToken", "next_page_token"),
        )

    async def get_document_content(self, *, node_id: str) -> DingTalkDocumentContent:
        """Read one document's markdown content by node ID."""
        payload = await self._call_tool(
            MCP_TOOL_GET_DOCUMENT_CONTENT,
            {"nodeId": node_id},
        )
        markdown: str | None = None
        for key in ("markdown", "content", "text", "plainText", "documentContent"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                markdown = value
                break
        if markdown is None:
            raise DingTalkMcpError(
                "invalid_response",
                "DingTalk Docs MCP returned document content without markdown",
            )
        return DingTalkDocumentContent(
            markdown=markdown,
            title=_as_string(payload, "title", "name") or "DingTalk Document",
            node_id=_as_string(payload, "nodeId", "node_id") or node_id,
            doc_url=_as_string(payload, "docUrl", "doc_url", "url", "sourceUri"),
        )

    async def _call_tool(
        self, tool_name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        """Call one tool and normalize its response envelope."""
        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamablehttp_client
        except ImportError as exc:
            raise DingTalkMcpError(
                "client_unavailable", "DingTalk Docs MCP client is unavailable"
            ) from exc

        try:
            async with streamablehttp_client(
                url=self._url,
                timeout=self._timeout_seconds,
                sse_read_timeout=MCP_SSE_READ_TIMEOUT_SECONDS,
            ) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await asyncio.wait_for(
                        session.initialize(), timeout=self._timeout_seconds
                    )
                    result = await asyncio.wait_for(
                        session.call_tool(tool_name, arguments),
                        timeout=self._timeout_seconds,
                    )
        except DingTalkMcpError:
            raise
        except asyncio.TimeoutError as exc:
            raise DingTalkMcpError(
                "timeout", "DingTalk Docs MCP request timed out"
            ) from exc
        except Exception as exc:
            raise DingTalkMcpError(
                _classify_exception(exc), "DingTalk Docs MCP request failed"
            ) from exc

        return _parse_tool_result(result, tool_name)


def _parse_tool_result(result: Any, tool_name: str) -> dict[str, Any]:
    """Parse a CallToolResult without turning errors into empty payloads."""
    if getattr(result, "isError", False) is True:
        raise DingTalkMcpError(
            _error_code_from_result(result), "DingTalk Docs MCP tool call failed"
        )

    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict):
        _raise_payload_error(structured)
        payload = _unwrap_payload(structured)
        _raise_payload_error(payload)
        return payload

    text_payloads: list[dict[str, Any]] = []
    plain_text: list[str] = []
    for content_item in getattr(result, "content", []) or []:
        if getattr(content_item, "type", None) != "text":
            continue
        text = str(getattr(content_item, "text", "") or "")
        try:
            decoded = json.loads(text)
        except (TypeError, json.JSONDecodeError):
            if text.strip():
                plain_text.append(text)
            continue
        if isinstance(decoded, dict):
            _raise_payload_error(decoded)
            text_payloads.append(decoded)

    if text_payloads:
        payload = _unwrap_payload(text_payloads[0])
        _raise_payload_error(payload)
        return payload

    if tool_name == MCP_TOOL_GET_DOCUMENT_CONTENT and plain_text:
        return {"markdown": "\n".join(plain_text)}

    raise DingTalkMcpError(
        "invalid_response", "DingTalk Docs MCP returned an unreadable response"
    )


def _unwrap_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Unwrap common MCP business envelopes while retaining error fields."""
    current = payload
    for key in ("result", "data"):
        nested = current.get(key)
        if isinstance(nested, dict) and not _has_business_fields(current):
            current = nested
    return current


def _has_business_fields(payload: dict[str, Any]) -> bool:
    return any(
        key in payload
        for key in (
            "documents",
            "items",
            "records",
            "nodes",
            "markdown",
            "content",
            "text",
            "title",
            "nodeId",
        )
    )


def _raise_payload_error(payload: dict[str, Any]) -> None:
    """Raise for explicit business or MCP errors reported in a JSON envelope."""
    if payload.get("success") is False:
        raise DingTalkMcpError(
            _error_code(payload), "DingTalk Docs MCP reported an unsuccessful call"
        )
    if any(payload.get(key) for key in ("error", "errorCode", "errorMsg")):
        raise DingTalkMcpError(
            _error_code(payload), "DingTalk Docs MCP returned an error"
        )


def _extract_list(
    payload: dict[str, Any], keys: tuple[str, ...]
) -> list[dict[str, Any]] | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            if not all(isinstance(item, dict) for item in value):
                raise DingTalkMcpError(
                    "invalid_response",
                    "DingTalk Docs MCP returned an invalid list item",
                )
            return [item for item in value if isinstance(item, dict)]
    return None


def _as_bool(payload: dict[str, Any], *keys: str) -> bool:
    for key in keys:
        if key in payload:
            return bool(payload[key])
    return False


def _as_string(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return None


def _error_code(payload: dict[str, Any]) -> str:
    value = payload.get("errorCode") or payload.get("code") or payload.get("errorMsg")
    normalized = str(value).lower() if value else ""
    if any(token in normalized for token in ("auth", "unauthorized", "forbidden")):
        return "authentication_error"
    if any(
        token in normalized for token in ("argument", "parameter", "param", "schema")
    ):
        return "parameter_error"
    return normalized or "tool_failed"


def _error_code_from_result(result: Any) -> str:
    for item in getattr(result, "content", []) or []:
        text = getattr(item, "text", "")
        if text:
            try:
                payload = json.loads(text)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                return _error_code(payload)
    return "tool_failed"


def _classify_exception(exc: Exception) -> str:
    """Classify transport errors without exposing provider exception text."""
    error_text = str(exc).lower()
    if any(token in error_text for token in ("tool", "method", "not found", "404")):
        return "tool_unavailable"
    if any(
        token in error_text
        for token in ("argument", "parameter", "param", "schema", "invalid")
    ):
        return "parameter_error"
    if any(
        token in error_text for token in ("401", "403", "unauthorized", "forbidden")
    ):
        return "authentication_error"
    return "request_failed"
