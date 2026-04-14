# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk Document Service.

This module provides services for interacting with DingTalk documents via MCP,
including fetching document metadata, downloading document content,
and managing document operations.
"""

import json
import logging
import re
from datetime import datetime
from typing import Any, Dict, Optional

import httpx

from app.core.config import settings
from app.services.mcp_provider_registry import get_mcp_provider_service
from app.services.user_mcp_service import UserMCPService

logger = logging.getLogger(__name__)


def sanitize_filename(title: str) -> str:
    """Sanitize a title for use in a filename.

    Removes or replaces characters that are invalid in filenames.

    Args:
        title: The title to sanitize

    Returns:
        Sanitized title safe for use in filenames
    """
    # Replace invalid filename characters with underscore
    safe_title = re.sub(r'[<>:"/\\|?*]', "_", title)
    safe_title = safe_title.strip()

    if not safe_title:
        safe_title = "untitled"

    return safe_title


def build_dingtalk_doc_filename(title: str, modified_time_formatted: str) -> str:
    """Build filename according to naming convention.

    Format: {title}_{modified_time}.md
    Example: 产品需求文档_20260413170933.md

    Args:
        title: Document title
        modified_time_formatted: Formatted modification time (YYYYMMDDHHMMSS)

    Returns:
        Safe filename
    """
    safe_title = sanitize_filename(title)
    return f"{safe_title}_{modified_time_formatted}.md"


class DingTalkDocsService:
    """Service for DingTalk document operations via MCP.

    Provides methods to:
    - Parse DingTalk document URLs
    - Fetch document metadata via dingtalk_docs MCP
    - Download document content via dingtalk_docs MCP
    """

    def __init__(self):
        """Initialize the DingTalk docs service."""
        pass

    def _extract_doc_id_from_url(self, url: str) -> Optional[str]:
        """Extract document ID from DingTalk document URL.

        Supports various DingTalk document URL formats:
        - https://alidocs.dingtalk.com/i/nodes/{doc_id}
        - https://alidocs.dingtalk.com/i/team/{team_id}/docs/{doc_id}
        - https://alidocs.dingtalk.com/i/team/{team_id}/wiki/{wiki_id}

        Args:
            url: DingTalk document URL

        Returns:
            Document ID if found, None otherwise
        """
        if not url:
            return None

        # Pattern for /i/nodes/{doc_id}
        node_pattern = r"alidocs\.dingtalk\.com/i/nodes/([a-zA-Z0-9_-]+)"
        match = re.search(node_pattern, url)
        if match:
            return match.group(1)

        # Pattern for /i/team/{team_id}/docs/{doc_id}
        docs_pattern = r"alidocs\.dingtalk\.com/i/team/[^/]+/docs/([a-zA-Z0-9_-]+)"
        match = re.search(docs_pattern, url)
        if match:
            return match.group(1)

        # Pattern for /i/team/{team_id}/wiki/{wiki_id}
        wiki_pattern = r"alidocs\.dingtalk\.com/i/team/[^/]+/wiki/([a-zA-Z0-9_-]+)"
        match = re.search(wiki_pattern, url)
        if match:
            return match.group(1)

        return None

    def _format_modified_time(self, modified_time: str) -> str:
        """Format modified time to YYYYMMDDHHMMSS format.

        Args:
            modified_time: ISO format datetime string or other formats

        Returns:
            Formatted string in YYYYMMDDHHMMSS format
        """
        try:
            # Try ISO format first
            dt = datetime.fromisoformat(modified_time.replace("Z", "+00:00"))
            return dt.strftime("%Y%m%d%H%M%S")
        except (ValueError, AttributeError):
            pass

        try:
            # Try common formats
            for fmt in [
                "%Y-%m-%d %H:%M:%S",
                "%Y/%m/%d %H:%M:%S",
                "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%dT%H:%M:%S.%f",
                "%Y-%m-%dT%H:%M:%S.%fZ",
            ]:
                try:
                    dt = datetime.strptime(modified_time, fmt)
                    return dt.strftime("%Y%m%d%H%M%S")
                except ValueError:
                    continue
        except Exception:
            pass

        # Return current time as fallback
        logger.warning(
            f"Could not parse modified_time: {modified_time}, using current time"
        )
        return datetime.now().strftime("%Y%m%d%H%M%S")

    def _get_dingtalk_docs_mcp_config(
        self, user_preferences: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        """Get dingtalk_docs MCP server config for user.

        Args:
            user_preferences: User's preferences JSON string

        Returns:
            MCP server config dict with 'name', 'url', 'type' or None if not configured
        """
        return UserMCPService.get_enabled_mcp_server(
            user_preferences,
            provider_id="dingtalk",
            service_id="docs",
            server_name="dingtalk_docs",
        )

    async def _call_dingtalk_mcp_tool(
        self,
        mcp_config: Dict[str, Any],
        tool_name: str,
        arguments: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Call a tool on the dingtalk_docs MCP server.

        Args:
            mcp_config: MCP server config with 'url'
            tool_name: Name of the tool to call
            arguments: Tool arguments

        Returns:
            Tool result dict

        Raises:
            ValueError: If MCP call fails
        """
        url = mcp_config.get("url", "").rstrip("/")
        if not url:
            raise ValueError("dingtalk_docs MCP URL not configured")

        # Build MCP tool call payload
        payload = {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments,
            },
            "id": 1,
        }

        logger.info(f"Calling dingtalk_docs MCP tool: {tool_name}")

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                result = response.json()
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error from DingTalk MCP: {e.response.status_code}")
            if e.response.status_code in (401, 403):
                raise ValueError(
                    "DingTalk authentication failed. Please check your MCP configuration."
                )
            raise ValueError(
                f"Failed to call DingTalk MCP: HTTP {e.response.status_code}"
            )

        if "error" in result:
            error_msg = result["error"].get("message", "Unknown MCP error")
            # Check for authentication-related errors
            if error_msg and any(
                keyword in error_msg.lower()
                for keyword in [
                    "auth",
                    "authentication",
                    "unauthorized",
                    "permission",
                    "access",
                ]
            ):
                raise ValueError(
                    f"DingTalk authentication required: {error_msg}\n"
                    f"Please ensure:\n"
                    f"1. You have access to this document in DingTalk\n"
                    f"2. The document is shared with you or is public\n"
                    f"3. Your DingTalk MCP configuration is correct"
                )
            raise ValueError(f"MCP tool call failed: {error_msg}")

        # Extract tool result from content
        content = result.get("result", {}).get("content", [])
        if content and len(content) > 0:
            text_content = content[0].get("text", "{}")
            try:
                return json.loads(text_content)
            except json.JSONDecodeError:
                return {"content": text_content}

        return {}

    async def get_document_info(
        self,
        doc_url: str,
        user_preferences: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get DingTalk document information via MCP.

        Args:
            doc_url: DingTalk document URL
            user_preferences: User's preferences JSON string (for MCP config)

        Returns:
            Dict containing document info:
            - doc_id: Document ID
            - title: Document title
            - modified_time: ISO format modification time
            - modified_time_formatted: YYYYMMDDHHMMSS format
            - content_type: Content type

        Raises:
            ValueError: If URL is invalid or document not found
        """
        doc_id = self._extract_doc_id_from_url(doc_url)
        if not doc_id:
            raise ValueError(f"Invalid DingTalk document URL: {doc_url}")

        logger.info(f"Fetching document info for doc_id: {doc_id}")

        # Get MCP config
        mcp_config = self._get_dingtalk_docs_mcp_config(user_preferences)
        if not mcp_config:
            logger.warning(
                "dingtalk_docs MCP not configured, returning placeholder info"
            )
            # Fallback to placeholder if MCP not configured
            now = datetime.now()
            return {
                "doc_id": doc_id,
                "title": f"DingTalkDoc_{doc_id[:8]}",
                "modified_time": now.isoformat(),
                "modified_time_formatted": now.strftime("%Y%m%d%H%M%S"),
                "content_type": "markdown",
                "url": doc_url,
            }

        # Call MCP tool to get document info
        try:
            result = await self._call_dingtalk_mcp_tool(
                mcp_config,
                tool_name="get_document_info",
                arguments={"doc_id": doc_id, "url": doc_url},
            )

            # Map MCP result to our format
            title = result.get("title", f"DingTalkDoc_{doc_id[:8]}")
            modified_time = result.get("modified_time", datetime.now().isoformat())

            return {
                "doc_id": doc_id,
                "title": title,
                "modified_time": modified_time,
                "modified_time_formatted": self._format_modified_time(modified_time),
                "content_type": result.get("content_type", "markdown"),
                "url": doc_url,
            }

        except Exception as e:
            logger.error(f"Failed to get document info from MCP: {e}")
            # Fallback to placeholder on error
            now = datetime.now()
            return {
                "doc_id": doc_id,
                "title": f"DingTalkDoc_{doc_id[:8]}",
                "modified_time": now.isoformat(),
                "modified_time_formatted": now.strftime("%Y%m%d%H%M%S"),
                "content_type": "markdown",
                "url": doc_url,
            }

    async def download_document_content(
        self,
        doc_url: str,
        user_preferences: Optional[str] = None,
        export_format: str = "markdown",
    ) -> Dict[str, Any]:
        """Download DingTalk document content via MCP.

        Args:
            doc_url: DingTalk document URL
            user_preferences: User's preferences JSON string (for MCP config)
            export_format: Export format (markdown, html, txt)

        Returns:
            Dict containing:
            - content: Document content as string
            - title: Document title
            - modified_time: Modification time
            - file_extension: Suggested file extension

        Raises:
            ValueError: If download fails
        """
        doc_id = self._extract_doc_id_from_url(doc_url)
        if not doc_id:
            raise ValueError(f"Invalid DingTalk document URL: {doc_url}")

        logger.info(f"Downloading document content for doc_id: {doc_id}")

        # Get MCP config
        mcp_config = self._get_dingtalk_docs_mcp_config(user_preferences)
        if not mcp_config:
            raise ValueError(
                "dingtalk_docs MCP not configured. "
                "Please configure DingTalk Docs MCP in user settings."
            )

        # Call MCP tool to download document content
        try:
            result = await self._call_dingtalk_mcp_tool(
                mcp_config,
                tool_name="download_document",
                arguments={
                    "doc_id": doc_id,
                    "url": doc_url,
                    "format": export_format,
                },
            )

            content = result.get("content", "")
            if not content:
                raise ValueError("Empty content returned from MCP")

            title = result.get("title", f"DingTalkDoc_{doc_id[:8]}")
            modified_time = result.get(
                "modified_time",
                result.get("last_modified", datetime.now().isoformat()),
            )

            return {
                "content": content,
                "title": title,
                "modified_time": modified_time,
                "modified_time_formatted": self._format_modified_time(modified_time),
                "file_extension": (
                    "md" if export_format == "markdown" else export_format
                ),
                "doc_id": doc_id,
            }

        except httpx.HTTPStatusError as e:
            logger.error(
                f"HTTP error from DingTalk MCP: {e.response.status_code} - {e.response.text}"
            )
            if e.response.status_code == 401 or e.response.status_code == 403:
                raise ValueError(
                    f"DingTalk authentication required. Please ensure:\n"
                    f"1. You have access to this document in DingTalk\n"
                    f"2. The document is shared with you or is public\n"
                    f"3. Your DingTalk MCP configuration is correct"
                )
            raise ValueError(
                f"Failed to download document from DingTalk: HTTP {e.response.status_code}"
            )
        except Exception as e:
            logger.error(f"Failed to download document from MCP: {e}")
            error_msg = str(e)
            if "authentication" in error_msg.lower() or "auth" in error_msg.lower():
                raise ValueError(
                    f"DingTalk authentication required: {error_msg}\n"
                    f"Please ensure you have access to this document in DingTalk."
                )
            raise ValueError(f"Failed to download document: {e}")

    def build_filename(self, title: str, modified_time_formatted: str) -> str:
        """Build filename according to naming convention.

        Format: {title}_{modified_time}.md
        Example: 产品需求文档_20260413170933.md

        Args:
            title: Document title
            modified_time_formatted: Formatted modification time (YYYYMMDDHHMMSS)

        Returns:
            Safe filename
        """
        return build_dingtalk_doc_filename(title, modified_time_formatted)


# Singleton instance
dingtalk_docs_service = DingTalkDocsService()
