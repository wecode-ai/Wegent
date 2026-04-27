# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MCP tools for DingTalk document upload to Wegent knowledge base.

This module provides tools to upload DingTalk documents to Wegent knowledge base
without using sandbox exec commands. It handles:
- Downloading files from URLs and uploading to Wegent
- Saving content to temporary files and uploading to Wegent
"""

import ipaddress
import logging
import os
import re
import socket
import unicodedata
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlparse

import requests
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import build_mcp_tools_dict, mcp_tool
from app.models.user import User
from app.services.context import context_service

logger = logging.getLogger(__name__)

# Default timeout for HTTP requests
DEFAULT_TIMEOUT = 300  # 5 minutes

# Security limits for URL downloads
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024  # 100 MB
ALLOWED_SCHEMES = {"http", "https"}
BLOCKED_HOSTS = {
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
}
BLOCKED_HOST_PATTERNS = [
    re.compile(r"^127\.\d+\.\d+\.\d+$"),  # 127.x.x.x
    re.compile(r"^10\.\d+\.\d+\.\d+$"),  # 10.x.x.x
    re.compile(r"^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$"),  # 172.16-31.x.x
    re.compile(r"^192\.168\.\d+\.\d+$"),  # 192.168.x.x
    re.compile(r"^169\.254\.\d+\.\d+$"),  # Link-local
    re.compile(r"\.internal$"),  # .internal domains
]


def _validate_download_url(url: str) -> None:
    """
    Validate download URL to prevent SSRF attacks.

    Args:
        url: URL to validate

    Raises:
        ValueError: If URL is invalid or blocked
    """
    parsed = urlparse(url)

    # Check scheme
    if parsed.scheme not in ALLOWED_SCHEMES:
        raise ValueError(f"URL scheme must be http or https, got: {parsed.scheme}")

    # Check hostname
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL must have a non-empty hostname")

    # Check blocked hosts
    if hostname.lower() in BLOCKED_HOSTS:
        raise ValueError(f"URL hostname is blocked: {hostname}")

    # Check blocked patterns
    for pattern in BLOCKED_HOST_PATTERNS:
        if pattern.match(hostname):
            raise ValueError(f"URL hostname matches blocked pattern: {hostname}")

    # Resolve and check IP address
    try:
        addrinfo = socket.getaddrinfo(hostname, None)
        for _, _, _, _, sockaddr in addrinfo:
            ip = ipaddress.ip_address(sockaddr[0])
            # Check for private, loopback, link-local, or reserved IPs
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_reserved
                or ip.is_multicast
            ):
                raise ValueError(f"URL resolves to blocked IP: {ip}")
    except socket.gaierror as e:
        raise ValueError(f"Failed to resolve hostname: {hostname}") from e


def _get_user_from_token(db: Session, token_info: TaskTokenInfo) -> Optional[User]:
    """Get user from token info."""
    return db.query(User).filter(User.id == token_info.user_id).first()


def _download_file_from_url(url: str) -> bytes:
    """
    Download file from URL with security validations.

    Args:
        url: Download URL

    Returns:
        Downloaded file content as bytes

    Raises:
        ValueError: If URL validation fails
        requests.RequestException: If download fails
    """
    # Validate URL before downloading
    _validate_download_url(url)

    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    }

    # Use stream=True and limit redirects for security
    with requests.get(
        url,
        headers=headers,
        stream=True,
        timeout=DEFAULT_TIMEOUT,
        allow_redirects=True,
    ) as response:
        response.raise_for_status()

        # Re-validate after redirects (if Location header present)
        if response.history:
            final_url = response.url
            _validate_download_url(final_url)

        total_size = 0
        chunks = []

        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                total_size += len(chunk)
                if total_size > MAX_DOWNLOAD_BYTES:
                    raise ValueError(
                        f"Download exceeds maximum size of {MAX_DOWNLOAD_BYTES} bytes"
                    )
                chunks.append(chunk)

    return b"".join(chunks)


def _get_filename_from_url(url: str, default_filename: str = "document") -> str:
    """
    Extract and sanitize filename from URL or use default.

    Decodes URL-encoded sequences, removes control/NUL characters, strips
    unsafe path separators and leading dots, and collapses unsafe characters
    to produce a safe, predictable filename token.

    Args:
        url: The URL to parse
        default_filename: Default filename if not found in URL

    Returns:
        Sanitized filename with extension, or default_filename if result is empty
    """
    parsed = urlparse(url)
    path = parsed.path
    if path:
        # URL-decode percent-encoded sequences (e.g. %20 -> space)
        basename = unquote(os.path.basename(path))

        # Remove NUL bytes and ASCII/Unicode control characters
        basename = "".join(
            ch for ch in basename if ch != "\x00" and unicodedata.category(ch) != "Cc"
        )

        # Strip path separators that could enable directory traversal
        basename = basename.replace("/", "").replace("\\", "")

        # Strip leading dots to avoid hidden files (e.g. ".bashrc")
        basename = basename.lstrip(".")

        # Collapse runs of whitespace/unsafe chars to a single underscore,
        # keeping alphanumerics, hyphens, underscores, dots, and Unicode letters
        basename = re.sub(r"[^\w\-.]", "_", basename)
        basename = re.sub(r"_+", "_", basename).strip("_")

        if basename and "." in basename:
            return basename

    return default_filename


@mcp_tool(
    name="dingtalk_upload_file_from_url",
    description=(
        "Download a file from URL and upload it to Wegent as an attachment. "
        "Returns attachment_id for use with wegent_kb_create_document."
    ),
    server="knowledge",
    param_descriptions={
        "download_url": (
            "The URL to download the file from "
            "(e.g., from dingtalk-docs.download_file)"
        ),
        "filename": (
            "Optional filename with extension. "
            "If not provided, will extract from URL or use default"
        ),
        "default_extension": (
            "Default file extension if filename cannot be determined "
            "(e.g., 'docx', 'pdf')"
        ),
    },
)
def upload_file_from_url(
    token_info: TaskTokenInfo,
    download_url: str,
    filename: Optional[str] = None,
    default_extension: str = "bin",
) -> Dict[str, Any]:
    """
    Download a file from URL and upload to Wegent as an attachment.

    This tool replaces the sandbox exec approach for downloading files
    from DingTalk and uploading to Wegent. It handles the entire process
    including temporary file management and cleanup.

    Args:
        token_info: Task token information containing user context
        download_url: The URL to download the file from
        filename: Optional filename with extension (e.g., "document.docx")
        default_extension: Default extension if filename cannot be determined

    Returns:
        Dict with attachment_id and upload status

    Example:
        upload_file_from_url(
            download_url="https://alidocs.dingtalk.com/...",
            filename="Specifications.docx"
        )
        Returns: {
            "attachment_id": 123,
            "filename": "Specifications.docx",
            "size": 10240
        }
    """
    db = SessionLocal()

    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}

        # Determine filename
        if not filename:
            filename = _get_filename_from_url(
                download_url, f"document.{default_extension}"
            )

        # Download file from URL with security validations
        logger.info(f"Downloading file from URL: {download_url}")
        binary_data = _download_file_from_url(download_url)
        file_size = len(binary_data)

        # Upload to Wegent using context service
        context, truncation_info = context_service.upload_attachment(
            db=db,
            user_id=user.id,
            filename=filename,
            binary_data=binary_data,
            subtask_id=0,  # Unlinked attachment
        )

        return {
            "attachment_id": context.id,
            "filename": filename,
            "size": file_size,
            "mime_type": context.mime_type,
            "truncated": (truncation_info.is_truncated if truncation_info else False),
        }

    except requests.RequestException as e:
        logger.error(f"Failed to download file from URL: {e!s}")
        db.rollback()
        return {"error": f"Failed to download file: {e!s}"}

    except ValueError as e:
        logger.error(f"URL validation failed: {e!s}")
        db.rollback()
        return {"error": f"URL validation failed: {e!s}"}

    except Exception as e:
        logger.error(f"Error uploading file from URL: {e!s}", exc_info=True)
        db.rollback()
        return {"error": str(e)}

    finally:
        db.close()


@mcp_tool(
    name="dingtalk_upload_content",
    description=(
        "Save content to a file and upload it to Wegent as an attachment. "
        "Returns attachment_id for use with wegent_kb_create_document."
    ),
    server="knowledge",
    param_descriptions={
        "content": (
            "The content to save "
            "(e.g., markdown text from dingtalk-docs.get_document_content)"
        ),
        "filename": "Filename with extension (e.g., 'document.md', 'spreadsheet.md')",
        "encoding": "Text encoding (default: utf-8)",
    },
)
def upload_content(
    token_info: TaskTokenInfo,
    content: str,
    filename: str,
    encoding: str = "utf-8",
) -> Dict[str, Any]:
    """
    Save content to a file and upload to Wegent as an attachment.

    This tool replaces the sandbox exec approach for saving content
    (e.g., markdown from DingTalk online documents) to a file and
    uploading to Wegent. It handles the entire process including
    temporary file management and cleanup.

    Args:
        token_info: Task token information containing user context
        content: The text content to save
        filename: Filename with extension (e.g., "document.md")
        encoding: Text encoding for saving the file

    Returns:
        Dict with attachment_id and upload status

    Example:
        upload_content(
            content="# Title\n\nContent from DingTalk...",
            filename="Specifications.md"
        )
        Returns: {
            "attachment_id": 456,
            "filename": "Specifications.md",
            "size": 2048
        }
    """
    db = SessionLocal()

    try:
        user = _get_user_from_token(db, token_info)
        if not user:
            return {"error": "User not found"}

        # Validate content
        if not content:
            return {"error": "Content cannot be empty"}

        # Validate filename
        if not filename:
            return {"error": "Filename is required"}

        # Encode content to bytes in memory (no filesystem roundtrip)
        try:
            binary_data = content.encode(encoding)
        except UnicodeEncodeError as e:
            logger.error(f"Encoding error when saving content: {e!s}")
            return {"error": f"Failed to encode content with {encoding}: {e!s}"}

        file_size = len(binary_data)

        # Upload to Wegent using context service
        context, truncation_info = context_service.upload_attachment(
            db=db,
            user_id=user.id,
            filename=filename,
            binary_data=binary_data,
            subtask_id=0,  # Unlinked attachment
        )

        return {
            "attachment_id": context.id,
            "filename": filename,
            "size": file_size,
            "mime_type": context.mime_type,
            "truncated": (truncation_info.is_truncated if truncation_info else False),
        }

    except Exception as e:
        logger.error(f"Error uploading content: {e!s}", exc_info=True)
        db.rollback()
        return {"error": str(e)}

    finally:
        db.close()


# Build tool registry from decorated functions
DINGTALK_UPLOAD_MCP_TOOLS = build_mcp_tools_dict(server="knowledge")
