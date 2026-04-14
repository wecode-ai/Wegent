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
from urllib.parse import urlparse

import httpx

from app.core.config import settings
from app.services.mcp_provider_registry import get_mcp_provider_service
from app.services.user_mcp_service import UserMCPService

logger = logging.getLogger(__name__)

# Constants
HTTP_TIMEOUT_SECONDS = 60.0
AUTH_ERROR_CODES = (401, 403)
DOC_ID_PREVIEW_LENGTH = 8


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

    def __init__(self) -> None:
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

        try:
            parsed = urlparse(url)
        except ValueError:
            return None

        # Validate hostname is alidocs.dingtalk.com
        if parsed.hostname != "alidocs.dingtalk.com":
            return None

        path = parsed.path or ""

        # Pattern for /i/nodes/{doc_id}
        node_pattern = r"^/i/nodes/([a-zA-Z0-9_-]+)"
        match = re.search(node_pattern, path)
        if match:
            return match.group(1)

        # Pattern for /i/team/{team_id}/docs/{doc_id}
        docs_pattern = r"^/i/team/[^/]+/docs/([a-zA-Z0-9_-]+)"
        match = re.search(docs_pattern, path)
        if match:
            return match.group(1)

        # Pattern for /i/team/{team_id}/wiki/{wiki_id}
        wiki_pattern = r"^/i/team/[^/]+/wiki/([a-zA-Z0-9_-]+)"
        match = re.search(wiki_pattern, path)
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
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                )
                response.raise_for_status()
                result = response.json()
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error from DingTalk MCP: {e.response.status_code}")
            logger.error(f"Response body: {e.response.text}")
            if e.response.status_code in AUTH_ERROR_CODES:
                raise ValueError(
                    "DingTalk authentication failed. Please check your MCP configuration."
                )
            if e.response.status_code == 406:
                raise ValueError(
                    f"DingTalk MCP request format not acceptable (HTTP 406). "
                    f"Response: {e.response.text}"
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
            raise ValueError(
                "dingtalk_docs MCP not configured. "
                "Please configure DingTalk Docs MCP in user settings."
            )

        # Call MCP tool to get document info
        # Note: DingTalk MCP get_document_info only requires nodeId parameter
        try:
            result = await self._call_dingtalk_mcp_tool(
                mcp_config,
                tool_name="get_document_info",
                arguments={"nodeId": doc_id},
            )

            # Map MCP result to our format
            title = result.get("title")
            modified_time = result.get("modified_time")
            if not title or not modified_time:
                raise ValueError("MCP response missing required document metadata")

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
            raise ValueError(f"Failed to get document info: {e}") from e

    async def download_document_content(
        self,
        doc_url: str,
        user_preferences: Optional[str] = None,
        export_format: str = "markdown",
    ) -> Dict[str, Any]:
        """Download DingTalk document content via MCP.

        According to DingTalk MCP documentation:
        1. First call get_document_info to get metadata (contentType, extension)
        2. Then choose the appropriate tool based on contentType and extension:
           - contentType=ALIDOC, extension=adoc → get_document_content(nodeId)
           - contentType=ALIDOC, extension=axls → dingtalk_table MCP
           - contentType=ALIDOC, extension=able → dingtalk_ai_table MCP
           - contentType≠ALIDOC and nodeType=file → download_file(nodeId)

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

        try:
            # Step 1: Get document info to determine content type
            doc_info = await self._call_dingtalk_mcp_tool(
                mcp_config,
                tool_name="get_document_info",
                arguments={"nodeId": doc_id},
            )

            title = doc_info.get(
                "title", f"DingTalkDoc_{doc_id[:DOC_ID_PREVIEW_LENGTH]}"
            )
            content_type = doc_info.get("contentType", "")
            extension = doc_info.get("extension", "")
            node_type = doc_info.get("nodeType", "")
            modified_time = doc_info.get("modifiedTime", datetime.now().isoformat())

            logger.info(
                f"Document info: contentType={content_type}, extension={extension}, nodeType={node_type}"
            )

            # Step 2: Choose appropriate tool based on contentType and extension
            content = ""

            if content_type == "ALIDOC" and extension == "adoc":
                # DingTalk online document - use get_document_content
                result = await self._call_dingtalk_mcp_tool(
                    mcp_config,
                    tool_name="get_document_content",
                    arguments={"nodeId": doc_id},
                )
                content = result.get("content", "")

            elif content_type == "ALIDOC" and extension == "axls":
                # DingTalk spreadsheet - requires dingtalk_table MCP
                raise ValueError(
                    "DingTalk spreadsheet documents are not supported yet. "
                    "Please use dingtalk_table MCP for spreadsheets."
                )

            elif content_type == "ALIDOC" and extension == "able":
                # DingTalk AI table - requires dingtalk_ai_table MCP
                raise ValueError(
                    "DingTalk AI table documents are not supported yet. "
                    "Please use dingtalk_ai_table MCP for AI tables."
                )

            elif content_type != "ALIDOC" and node_type == "file":
                # Regular file - use download_file
                result = await self._call_dingtalk_mcp_tool(
                    mcp_config,
                    tool_name="download_file",
                    arguments={"nodeId": doc_id},
                )
                # download_file returns a download link
                download_url = result.get("downloadUrl", "")
                if download_url:
                    # Fetch the file content from the download URL
                    async with httpx.AsyncClient(
                        timeout=HTTP_TIMEOUT_SECONDS
                    ) as client:
                        file_response = await client.get(download_url)
                        file_response.raise_for_status()
                        content = file_response.text
                else:
                    raise ValueError("No download URL returned from DingTalk")

            else:
                # Try get_document_content as fallback
                logger.warning(
                    f"Unknown content type: {content_type}/{extension}, trying get_document_content"
                )
                result = await self._call_dingtalk_mcp_tool(
                    mcp_config,
                    tool_name="get_document_content",
                    arguments={"nodeId": doc_id},
                )
                content = result.get("content", "")

            if not content:
                raise ValueError("Empty content returned from DingTalk MCP")

            return {
                "content": content,
                "title": title,
                "modified_time": modified_time,
                "modified_time_formatted": self._format_modified_time(modified_time),
                "file_extension": ("md" if extension == "adoc" else extension or "md"),
                "doc_id": doc_id,
                "content_type": content_type,
                "extension": extension,
            }

        except httpx.HTTPStatusError as e:
            logger.error(
                f"HTTP error from DingTalk MCP: {e.response.status_code} - {e.response.text}"
            )
            if e.response.status_code in AUTH_ERROR_CODES:
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
