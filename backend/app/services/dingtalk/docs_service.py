# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk Document Service.

This module provides services for interacting with DingTalk documents,
including fetching document metadata, downloading document content,
and managing document operations.
"""

import logging
import re
from datetime import datetime
from typing import Any, Dict, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


class DingTalkDocsService:
    """Service for DingTalk document operations.

    Provides methods to:
    - Parse DingTalk document URLs
    - Fetch document metadata (title, modification time, etc.)
    - Download document content
    """

    # DingTalk API endpoints
    DINGTALK_API_BASE = "https://oapi.dingtalk.com"

    def __init__(self):
        """Initialize the DingTalk docs service."""
        self.app_key = getattr(settings, "DINGTALK_APP_KEY", "")
        self.app_secret = getattr(settings, "DINGTALK_APP_SECRET", "")

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

    async def get_document_info(
        self, doc_url: str, access_token: Optional[str] = None
    ) -> Dict[str, Any]:
        """Get DingTalk document information.

        Args:
            doc_url: DingTalk document URL
            access_token: Optional access token for authenticated requests

        Returns:
            Dict containing document info:
            - doc_id: Document ID
            - title: Document title
            - modified_time: ISO format modification time
            - modified_time_formatted: YYYYMMDDHHMMSS format
            - content_type: Content type (markdown, html, etc.)

        Raises:
            ValueError: If URL is invalid or document not found
        """
        doc_id = self._extract_doc_id_from_url(doc_url)
        if not doc_id:
            raise ValueError(f"Invalid DingTalk document URL: {doc_url}")

        logger.info(f"Fetching document info for doc_id: {doc_id}")

        # For now, return basic info extracted from URL
        # In production, this would call DingTalk API to get actual metadata
        # This is a placeholder implementation that can be extended

        # Generate a title from the doc_id (in real implementation, fetch from API)
        title = f"DingTalkDoc_{doc_id[:8]}"

        # Use current time as modified time (in real implementation, fetch from API)
        now = datetime.now()
        modified_time = now.isoformat()
        modified_time_formatted = now.strftime("%Y%m%d%H%M%S")

        return {
            "doc_id": doc_id,
            "title": title,
            "modified_time": modified_time,
            "modified_time_formatted": modified_time_formatted,
            "content_type": "markdown",
            "url": doc_url,
        }

    async def download_document_content(
        self,
        doc_url: str,
        access_token: Optional[str] = None,
        export_format: str = "markdown",
    ) -> Dict[str, Any]:
        """Download DingTalk document content.

        Args:
            doc_url: DingTalk document URL
            access_token: Optional access token for authenticated requests
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
        doc_info = await self.get_document_info(doc_url, access_token)

        logger.info(f"Downloading document content for: {doc_info['title']}")

        # Placeholder implementation
        # In production, this would:
        # 1. Call DingTalk API to export document
        # 2. Download the exported content
        # 3. Return the content

        # For now, return a placeholder content
        content = f"# {doc_info['title']}\n\nThis is a placeholder content for the DingTalk document.\n\nDocument ID: {doc_info['doc_id']}\n"

        file_extension = "md" if export_format == "markdown" else export_format

        return {
            "content": content,
            "title": doc_info["title"],
            "modified_time": doc_info["modified_time"],
            "modified_time_formatted": doc_info["modified_time_formatted"],
            "file_extension": file_extension,
            "doc_id": doc_info["doc_id"],
        }

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
        # Sanitize title for filename
        safe_title = re.sub(r'[<>:"/\\|?*]', "_", title)
        safe_title = safe_title.strip()

        if not safe_title:
            safe_title = "untitled"

        return f"{safe_title}_{modified_time_formatted}.md"


# Singleton instance
dingtalk_docs_service = DingTalkDocsService()
