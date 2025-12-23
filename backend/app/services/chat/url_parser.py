# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
URL Parser Service for Chat Shell.

Provides automatic URL detection and content parsing functionality.
Supports webpage, image, and PDF content extraction.
"""

import asyncio
import base64
import logging
import mimetypes
import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional
from urllib.parse import urlparse

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Configuration constants with defaults
URL_PARSER_MAX_CHARS = getattr(settings, "URL_PARSER_MAX_CHARS", 200000)
URL_PARSER_TIMEOUT = getattr(settings, "URL_PARSER_TIMEOUT", 30)
URL_PARSER_MAX_IMAGE_SIZE = getattr(settings, "URL_PARSER_MAX_IMAGE_SIZE", 10 * 1024 * 1024)

# Image file extensions
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}

# PDF file extension
PDF_EXTENSION = ".pdf"


class UrlType(str, Enum):
    """Type of URL content."""

    WEBPAGE = "webpage"
    IMAGE = "image"
    PDF = "pdf"
    UNKNOWN = "unknown"


@dataclass
class ParsedUrlResult:
    """Result of URL parsing."""

    url: str
    type: UrlType
    title: Optional[str] = None
    content: Optional[str] = None
    truncated: bool = False
    error: Optional[str] = None
    size: Optional[int] = None  # Content size in bytes


class UrlParser:
    """URL content parser service."""

    def __init__(self):
        self.timeout = URL_PARSER_TIMEOUT
        self.max_chars = URL_PARSER_MAX_CHARS
        self.max_image_size = URL_PARSER_MAX_IMAGE_SIZE

    async def parse_urls(self, urls: list[str]) -> list[ParsedUrlResult]:
        """
        Parse multiple URLs concurrently.

        Args:
            urls: List of URLs to parse

        Returns:
            List of ParsedUrlResult objects
        """
        tasks = [self._parse_single_url(url) for url in urls]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        parsed_results = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                parsed_results.append(
                    ParsedUrlResult(
                        url=urls[i],
                        type=UrlType.UNKNOWN,
                        error=str(result),
                    )
                )
            else:
                parsed_results.append(result)

        return parsed_results

    async def _parse_single_url(self, url: str) -> ParsedUrlResult:
        """
        Parse a single URL and extract its content.

        Args:
            url: URL to parse

        Returns:
            ParsedUrlResult object
        """
        try:
            # Validate URL format
            parsed = urlparse(url)
            if not parsed.scheme or not parsed.netloc:
                return ParsedUrlResult(
                    url=url,
                    type=UrlType.UNKNOWN,
                    error="Invalid URL format",
                )

            # Detect URL type from extension first
            url_type = self._detect_type_from_url(url)

            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                },
            ) as client:
                # For images and PDFs detected by extension, use GET directly
                if url_type in (UrlType.IMAGE, UrlType.PDF):
                    return await self._fetch_and_parse(client, url, url_type)

                # For other URLs, do HEAD request first to check content type
                try:
                    head_response = await client.head(url)
                    content_type = head_response.headers.get("content-type", "").lower()
                    url_type = self._detect_type_from_content_type(content_type)
                except httpx.HTTPError:
                    # HEAD failed, try GET directly
                    url_type = UrlType.WEBPAGE

                return await self._fetch_and_parse(client, url, url_type)

        except httpx.TimeoutException:
            return ParsedUrlResult(
                url=url,
                type=UrlType.UNKNOWN,
                error=f"Request timed out after {self.timeout} seconds",
            )
        except httpx.HTTPError as e:
            return ParsedUrlResult(
                url=url,
                type=UrlType.UNKNOWN,
                error=f"HTTP error: {str(e)}",
            )
        except Exception as e:
            logger.exception(f"Error parsing URL {url}")
            return ParsedUrlResult(
                url=url,
                type=UrlType.UNKNOWN,
                error=f"Parse error: {str(e)}",
            )

    def _detect_type_from_url(self, url: str) -> UrlType:
        """Detect URL type from file extension."""
        parsed = urlparse(url)
        path = parsed.path.lower()

        # Check for image extensions
        for ext in IMAGE_EXTENSIONS:
            if path.endswith(ext):
                return UrlType.IMAGE

        # Check for PDF
        if path.endswith(PDF_EXTENSION):
            return UrlType.PDF

        return UrlType.UNKNOWN

    def _detect_type_from_content_type(self, content_type: str) -> UrlType:
        """Detect URL type from content-type header."""
        if "image/" in content_type:
            return UrlType.IMAGE
        if "application/pdf" in content_type:
            return UrlType.PDF
        if "text/html" in content_type or "application/xhtml" in content_type:
            return UrlType.WEBPAGE
        return UrlType.WEBPAGE  # Default to webpage for unknown types

    async def _fetch_and_parse(
        self, client: httpx.AsyncClient, url: str, url_type: UrlType
    ) -> ParsedUrlResult:
        """Fetch URL content and parse based on type."""
        response = await client.get(url)
        response.raise_for_status()

        # Re-check content type from actual response
        content_type = response.headers.get("content-type", "").lower()
        actual_type = self._detect_type_from_content_type(content_type)

        # Use actual type if it differs from URL-based detection
        if url_type == UrlType.UNKNOWN:
            url_type = actual_type

        if url_type == UrlType.IMAGE:
            return await self._parse_image(url, response)
        elif url_type == UrlType.PDF:
            return await self._parse_pdf(url, response)
        else:
            return await self._parse_webpage(url, response)

    async def _parse_webpage(
        self, url: str, response: httpx.Response
    ) -> ParsedUrlResult:
        """Parse webpage content to markdown."""
        try:
            html_content = response.text

            # Extract title
            title = self._extract_title(html_content)

            # Convert HTML to markdown
            markdown_content = self._html_to_markdown(html_content)

            # Truncate if necessary
            truncated = False
            if len(markdown_content) > self.max_chars:
                markdown_content = markdown_content[: self.max_chars]
                markdown_content += "\n\n[Content truncated...]"
                truncated = True

            return ParsedUrlResult(
                url=url,
                type=UrlType.WEBPAGE,
                title=title,
                content=markdown_content,
                truncated=truncated,
                size=len(response.content),
            )

        except Exception as e:
            logger.exception(f"Error parsing webpage {url}")
            return ParsedUrlResult(
                url=url,
                type=UrlType.WEBPAGE,
                error=f"Failed to parse webpage: {str(e)}",
            )

    async def _parse_image(self, url: str, response: httpx.Response) -> ParsedUrlResult:
        """Parse image to base64 data URL."""
        try:
            content_length = len(response.content)

            # Check image size
            if content_length > self.max_image_size:
                return ParsedUrlResult(
                    url=url,
                    type=UrlType.IMAGE,
                    error=f"Image too large: {content_length} bytes (max: {self.max_image_size} bytes)",
                    size=content_length,
                )

            # Detect MIME type
            content_type = response.headers.get("content-type", "")
            if not content_type or "image/" not in content_type:
                # Try to guess from URL
                mime_type, _ = mimetypes.guess_type(url)
                content_type = mime_type or "image/png"

            # Convert to base64 data URL
            base64_content = base64.b64encode(response.content).decode("utf-8")
            data_url = f"data:{content_type};base64,{base64_content}"

            return ParsedUrlResult(
                url=url,
                type=UrlType.IMAGE,
                content=data_url,
                size=content_length,
            )

        except Exception as e:
            logger.exception(f"Error parsing image {url}")
            return ParsedUrlResult(
                url=url,
                type=UrlType.IMAGE,
                error=f"Failed to parse image: {str(e)}",
            )

    async def _parse_pdf(self, url: str, response: httpx.Response) -> ParsedUrlResult:
        """Parse PDF and extract text content."""
        try:
            from io import BytesIO

            try:
                from pypdf import PdfReader
            except ImportError:
                try:
                    from PyPDF2 import PdfReader
                except ImportError:
                    return ParsedUrlResult(
                        url=url,
                        type=UrlType.PDF,
                        error="PDF parsing library not available",
                    )

            content_length = len(response.content)

            # Parse PDF
            pdf_file = BytesIO(response.content)
            reader = PdfReader(pdf_file)

            # Extract text from all pages
            text_parts = []
            for page in reader.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)

            full_text = "\n\n".join(text_parts)

            # Get title from PDF metadata if available
            title = None
            if reader.metadata and reader.metadata.title:
                title = reader.metadata.title

            # Truncate if necessary
            truncated = False
            if len(full_text) > self.max_chars:
                full_text = full_text[: self.max_chars]
                full_text += "\n\n[Content truncated...]"
                truncated = True

            return ParsedUrlResult(
                url=url,
                type=UrlType.PDF,
                title=title,
                content=full_text,
                truncated=truncated,
                size=content_length,
            )

        except Exception as e:
            logger.exception(f"Error parsing PDF {url}")
            return ParsedUrlResult(
                url=url,
                type=UrlType.PDF,
                error=f"Failed to parse PDF: {str(e)}",
            )

    def _extract_title(self, html: str) -> Optional[str]:
        """Extract title from HTML."""
        # Try to find <title> tag
        title_match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
        if title_match:
            return title_match.group(1).strip()

        # Try to find <h1> tag
        h1_match = re.search(r"<h1[^>]*>([^<]+)</h1>", html, re.IGNORECASE)
        if h1_match:
            return h1_match.group(1).strip()

        return None

    def _html_to_markdown(self, html: str) -> str:
        """Convert HTML to markdown."""
        try:
            # Try to use html2text if available
            import html2text

            h = html2text.HTML2Text()
            h.ignore_links = False
            h.ignore_images = False
            h.ignore_emphasis = False
            h.body_width = 0  # Don't wrap lines
            return h.handle(html)
        except ImportError:
            pass

        try:
            # Try to use markdownify as fallback
            from markdownify import markdownify

            return markdownify(html, heading_style="ATX")
        except ImportError:
            pass

        # Fallback: basic HTML tag stripping using BeautifulSoup
        try:
            from bs4 import BeautifulSoup

            soup = BeautifulSoup(html, "html.parser")

            # Remove script and style elements
            for script in soup(["script", "style", "nav", "footer", "header"]):
                script.decompose()

            # Get text
            text = soup.get_text(separator="\n")

            # Clean up whitespace
            lines = (line.strip() for line in text.splitlines())
            chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
            text = "\n".join(chunk for chunk in chunks if chunk)

            return text
        except ImportError:
            pass

        # Last resort: regex-based tag stripping
        # Remove script and style content
        html = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r"<style[^>]*>.*?</style>", "", html, flags=re.DOTALL | re.IGNORECASE)

        # Remove all HTML tags
        text = re.sub(r"<[^>]+>", "", html)

        # Decode HTML entities
        import html as html_module

        text = html_module.unescape(text)

        # Clean up whitespace
        text = re.sub(r"\s+", " ", text)
        text = re.sub(r"\n\s*\n", "\n\n", text)

        return text.strip()


# Global URL parser instance
url_parser = UrlParser()
