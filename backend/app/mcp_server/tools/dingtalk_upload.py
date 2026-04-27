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

import logging
import os
import tempfile
from typing import Any, Dict, Optional
from urllib.parse import urlparse

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


def _get_user_from_token(db: Session, token_info: TaskTokenInfo) -> Optional[User]:
    """Get user from token info."""
    return db.query(User).filter(User.id == token_info.user_id).first()


def _download_file_from_url(url: str, temp_file_path: str) -> int:
    """
    Download file from URL to temporary file.

    Args:
        url: Download URL
        temp_file_path: Path to save the file

    Returns:
        File size in bytes

    Raises:
        requests.RequestException: If download fails
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }

    with requests.get(
        url, headers=headers, stream=True, timeout=DEFAULT_TIMEOUT
    ) as response:
        response.raise_for_status()
        total_size = 0
        with open(temp_file_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    total_size += len(chunk)

    return total_size


def _get_filename_from_url(url: str, default_filename: str = "document") -> str:
    """
    Extract filename from URL or use default.

    Args:
        url: The URL to parse
        default_filename: Default filename if not found in URL

    Returns:
        Filename with extension
    """
    parsed = urlparse(url)
    path = parsed.path
    if path:
        filename = os.path.basename(path)
        if filename and "." in filename:
            return filename
    return default_filename


def _clean_temp_file(temp_file_path: str) -> None:
    """
    Clean up temporary file if it exists.

    Args:
        temp_file_path: Path to temporary file
    """
    try:
        if temp_file_path and os.path.exists(temp_file_path):
            os.remove(temp_file_path)
            logger.debug(f"Cleaned up temporary file: {temp_file_path}")
    except Exception as e:
        logger.warning(f"Failed to clean up temporary file {temp_file_path}: {e}")


@mcp_tool(
    name="dingtalk_upload_file_from_url",
    description="Download a file from URL and upload it to Wegent as an attachment. Returns attachment_id for use with wegent_kb_create_document.",
    server="knowledge",
    param_descriptions={
        "download_url": "The URL to download the file from (e.g., from dingtalk-docs.download_file)",
        "filename": "Optional filename with extension. If not provided, will extract from URL or use default",
        "default_extension": "Default file extension if filename cannot be determined (e.g., 'docx', 'pdf')",
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
        Returns: {"attachment_id": 123, "filename": "Specifications.docx", "size": 10240}
    """
    temp_file_path = None
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

        # Create temporary file with proper extension
        file_extension = os.path.splitext(filename)[1] or f".{default_extension}"
        with tempfile.NamedTemporaryFile(
            delete=False, suffix=file_extension
        ) as temp_file:
            temp_file_path = temp_file.name

        try:
            # Download file from URL
            logger.info(f"Downloading file from URL to {temp_file_path}")
            file_size = _download_file_from_url(download_url, temp_file_path)

            # Read file content
            with open(temp_file_path, "rb") as f:
                binary_data = f.read()

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
                "truncated": truncation_info.is_truncated if truncation_info else False,
            }

        except requests.RequestException as e:
            logger.error(f"Failed to download file from URL: {e}")
            return {"error": f"Failed to download file: {str(e)}"}

    except Exception as e:
        logger.error(f"Error uploading file from URL: {e}", exc_info=True)
        return {"error": str(e)}

    finally:
        db.close()
        _clean_temp_file(temp_file_path)


@mcp_tool(
    name="dingtalk_upload_content",
    description="Save content to a file and upload it to Wegent as an attachment. Returns attachment_id for use with wegent_kb_create_document.",
    server="knowledge",
    param_descriptions={
        "content": "The content to save (e.g., markdown text from dingtalk-docs.get_document_content)",
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
        Returns: {"attachment_id": 456, "filename": "Specifications.md", "size": 2048}
    """
    temp_file_path = None
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

        # Create temporary file with proper extension
        file_extension = os.path.splitext(filename)[1] or ".md"
        with tempfile.NamedTemporaryFile(
            delete=False, suffix=file_extension
        ) as temp_file:
            temp_file_path = temp_file.name

        try:
            # Write content to temporary file
            logger.info(f"Writing content to temporary file {temp_file_path}")
            with open(temp_file_path, "w", encoding=encoding) as f:
                f.write(content)

            # Read file content as binary for upload
            with open(temp_file_path, "rb") as f:
                binary_data = f.read()

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
                "truncated": truncation_info.is_truncated if truncation_info else False,
            }

        except UnicodeEncodeError as e:
            logger.error(f"Encoding error when saving content: {e}")
            return {"error": f"Failed to encode content with {encoding}: {str(e)}"}

    except Exception as e:
        logger.error(f"Error uploading content: {e}", exc_info=True)
        return {"error": str(e)}

    finally:
        db.close()
        _clean_temp_file(temp_file_path)


# Build tool registry from decorated functions
DINGTALK_UPLOAD_MCP_TOOLS = build_mcp_tools_dict(server="knowledge")
