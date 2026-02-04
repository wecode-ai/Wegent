# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment downloader service for executor.

Downloads attachments from Backend API to local workspace,
similar to the skill download pattern.
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

import requests

logger = logging.getLogger(__name__)


# Re-export get_api_base_url for backward compatibility
from executor.services.api_client import get_api_base_url  # noqa: E402


@dataclass
class AttachmentDownloadResult:
    """Result of attachment download operation"""

    success: List[Dict[str, Any]]  # Successfully downloaded attachments
    failed: List[Dict[str, Any]]  # Failed attachments with error info


class AttachmentDownloader:
    """Download attachments from Backend API to local workspace"""

    # Default timeout for download requests (5 minutes for large files)
    DEFAULT_TIMEOUT = 300

    def __init__(
        self,
        workspace: str,
        task_id: str,
        subtask_id: str,
        auth_token: str,
    ):
        """
        Initialize attachment downloader.

        Args:
            workspace: Base workspace directory path
            task_id: Task ID for organizing attachments
            subtask_id: Subtask ID for organizing attachments
            auth_token: JWT token for authenticated API calls
        """
        self.workspace = workspace
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.auth_token = auth_token
        self.headers = {"Authorization": f"Bearer {auth_token}"}
        # Get API base URL based on executor mode
        self.api_base_url = get_api_base_url()

    def get_attachments_dir(self) -> str:
        """
        Get attachments directory path.

        Returns:
            Path in format: {workspace}/{task_id}:executor:attachments/{subtask_id}/
        """
        return os.path.join(
            self.workspace,
            f"{self.task_id}:executor:attachments",
            str(self.subtask_id),
        )

    def get_attachment_path(self, filename: str) -> str:
        """
        Get full path for an attachment file.

        Args:
            filename: Original filename of the attachment

        Returns:
            Full path to the attachment file
        """
        # Sanitize filename to prevent path traversal attacks
        safe_filename = self._sanitize_filename(filename)
        return os.path.join(self.get_attachments_dir(), safe_filename)

    @staticmethod
    def _sanitize_filename(filename: str) -> str:
        """
        Sanitize filename to prevent path traversal and metadata corruption.

        Args:
            filename: Original filename

        Returns:
            Sanitized filename safe for filesystem operations
        """
        # Use basename to strip any directory components
        safe_name = os.path.basename(filename)
        # Strip control characters (newline, carriage return)
        safe_name = safe_name.replace("\n", "").replace("\r", "")
        # Remove any remaining path separators
        safe_name = safe_name.replace("/", "_").replace("\\", "_")
        return safe_name or "document"

    def download_all(
        self, attachments: List[Dict[str, Any]]
    ) -> AttachmentDownloadResult:
        """
        Download all attachments to workspace.

        Args:
            attachments: List of attachment metadata from task_data

        Returns:
            AttachmentDownloadResult with success and failed lists
        """
        if not attachments:
            logger.debug("No attachments to download")
            return AttachmentDownloadResult(success=[], failed=[])

        logger.info(
            f"Downloading {len(attachments)} attachments, api_base_url={self.api_base_url}"
        )

        # Create attachments directory
        attachments_dir = self.get_attachments_dir()
        Path(attachments_dir).mkdir(parents=True, exist_ok=True)
        logger.info(f"Created attachments directory: {attachments_dir}")

        success = []
        failed = []

        for att in attachments:
            result = self._download_single(att)
            if "error" in result:
                failed.append(result)
            else:
                success.append(result)

        logger.info(
            f"Attachment download complete: {len(success)} success, {len(failed)} failed"
        )
        return AttachmentDownloadResult(success=success, failed=failed)

    def _build_download_url(self, att_id: int) -> str:
        """
        Build download URL for an attachment.

        Similar to skill downloads, the executor constructs the URL using
        TASK_API_DOMAIN environment variable instead of relying on backend
        to provide the full URL.

        Args:
            att_id: Attachment ID

        Returns:
            Full download URL
        """
        return f"{self.api_base_url}/api/attachments/{att_id}/executor-download"

    def _download_single(self, att: Dict[str, Any]) -> Dict[str, Any]:
        """
        Download a single attachment.

        Args:
            att: Attachment metadata dict

        Returns:
            Dict with attachment info and local_path (success) or error (failure)
        """
        att_id = att.get("id")
        filename = att.get("original_filename")

        if not all([att_id, filename]):
            logger.warning(f"Attachment missing required fields: {att}")
            return {**att, "error": "Missing required fields (id or original_filename)"}

        # Build download URL using TASK_API_DOMAIN, similar to skill downloads
        download_url = self._build_download_url(att_id)
        logger.info(
            f"Downloading attachment: {filename} (id={att_id}) from {download_url}"
        )

        try:
            # Download file with streaming for large files
            response = requests.get(
                download_url,
                headers=self.headers,
                timeout=self.DEFAULT_TIMEOUT,
                stream=True,
            )

            if response.status_code != 200:
                error_msg = f"HTTP {response.status_code}"
                logger.error(f"Failed to download attachment '{filename}': {error_msg}")
                return {**att, "error": error_msg}

            # Save file to workspace
            file_path = self.get_attachment_path(filename)
            with open(file_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            logger.info(f"Downloaded attachment '{filename}' to {file_path}")
            return {**att, "local_path": file_path}

        except requests.exceptions.Timeout:
            error_msg = "Download timeout"
            logger.error(f"Timeout downloading attachment '{filename}': {error_msg}")
            return {**att, "error": error_msg}
        except requests.exceptions.RequestException as e:
            error_msg = f"Request error: {str(e)}"
            logger.error(f"Request error downloading attachment '{filename}': {e}")
            return {**att, "error": error_msg}
        except IOError as e:
            error_msg = f"IO error: {str(e)}"
            logger.error(f"IO error saving attachment '{filename}': {e}")
            return {**att, "error": error_msg}
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error downloading attachment '{filename}': {e}")
            return {**att, "error": error_msg}
