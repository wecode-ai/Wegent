# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Lightweight table URL parser for backend.

This module provides URL parsing functionality without the heavy
dependencies of the full table service implementation.

For full table data querying, use chat_shell service.
"""

import logging
import re
from dataclasses import dataclass
from typing import Dict, Optional
from urllib.parse import parse_qs, unquote, urlparse

logger = logging.getLogger(__name__)


@dataclass
class TableContext:
    """Parsed table context from URL."""

    base_id: str
    sheet_id_or_name: str

    def to_dict(self) -> Dict[str, str]:
        """Convert to dictionary for prompt injection."""
        return {
            "baseId": self.base_id,
            "sheetIdOrName": self.sheet_id_or_name,
        }


class TableURLParser:
    """Lightweight URL parser for table providers."""

    # DingTalk URL patterns
    DINGTALK_PATTERNS = [
        r"aitable\.dingtalk\.com",
        r"notable\.dingtalk\.com",
        r"alidocs\.dingtalk\.com",
    ]

    @classmethod
    def detect_provider_from_url(cls, url: str) -> Optional[str]:
        """
        Detect table provider type from URL.

        Args:
            url: Table URL

        Returns:
            Provider type ('dingtalk', etc.) or None
        """
        url_lower = url.lower()

        # Check DingTalk patterns
        for pattern in cls.DINGTALK_PATTERNS:
            if re.search(pattern, url_lower):
                return "dingtalk"

        return None

    @classmethod
    def parse_dingtalk_url(cls, url: str) -> Optional[TableContext]:
        """
        Parse DingTalk table URL.

        Supported formats:
        1. https://aitable.dingtalk.com/base/dstXXX/tblYYY
        2. https://notable.dingtalk.com/space/base/dstXXX/tblYYY
        3. https://alidocs.dingtalk.com/i/nodes/{baseId}?iframeQuery=...&sheetId=XXX

        Args:
            url: DingTalk table URL

        Returns:
            TableContext with base_id and sheet_id, or None if parsing fails
        """
        # Pattern 1: aitable.dingtalk.com/base/dstXXX/tblYYY
        match = re.search(
            r"aitable\.dingtalk\.com/base/(dst[a-zA-Z0-9]+)(?:/([a-zA-Z0-9]+))?",
            url,
        )
        if match:
            base_id = match.group(1)
            sheet_id = match.group(2) or ""
            return TableContext(base_id=base_id, sheet_id_or_name=sheet_id)

        # Pattern 2: notable.dingtalk.com/space/base/dstXXX/tblYYY
        match = re.search(
            r"notable\.dingtalk\.com/(?:space/)?base/(dst[a-zA-Z0-9]+)(?:/([a-zA-Z0-9]+))?",
            url,
        )
        if match:
            base_id = match.group(1)
            sheet_id = match.group(2) or ""
            return TableContext(base_id=base_id, sheet_id_or_name=sheet_id)

        # Pattern 3: alidocs.dingtalk.com/i/nodes/{baseId}?iframeQuery=...&sheetId=XXX
        if "alidocs.dingtalk.com" in url:
            try:
                parsed = urlparse(url)

                # Extract baseId from path: /i/nodes/{baseId}
                path_match = re.search(r"/nodes/([^/?]+)", parsed.path)
                if not path_match:
                    return None

                base_id = path_match.group(1)

                # Extract sheetId from iframeQuery parameter
                query_params = parse_qs(parsed.query)
                iframe_query = query_params.get("iframeQuery", [""])[0]

                sheet_id = ""
                if iframe_query:
                    # URL decode the iframeQuery value
                    decoded_query = unquote(iframe_query)
                    # Parse the inner query string
                    inner_params = parse_qs(decoded_query)
                    sheet_id = inner_params.get("sheetId", [""])[0]

                return TableContext(base_id=base_id, sheet_id_or_name=sheet_id)
            except Exception as e:
                logger.warning(f"Failed to parse alidocs URL: {url}, error: {e}")
                return None

        return None

    @classmethod
    def parse_url(cls, url: str) -> Optional[TableContext]:
        """
        Parse table URL from any supported provider.

        Args:
            url: Table URL

        Returns:
            TableContext or None if parsing fails
        """
        provider = cls.detect_provider_from_url(url)

        if provider == "dingtalk":
            return cls.parse_dingtalk_url(url)

        logger.warning(f"Unsupported table provider for URL: {url}")
        return None

    @classmethod
    def parse_table_url(cls, url: str) -> Optional[Dict[str, str]]:
        """
        Parse table URL and return dict with provider info.

        Args:
            url: Table URL

        Returns:
            Dict with 'provider', 'baseId', 'sheetIdOrName' or None
        """
        provider = cls.detect_provider_from_url(url)
        context = cls.parse_url(url)

        if context and provider:
            result = context.to_dict()
            result["provider"] = provider
            return result

        return None
