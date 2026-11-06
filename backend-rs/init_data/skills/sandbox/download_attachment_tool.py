# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox attachment download tool using curl command.

This module provides the SandboxDownloadAttachmentTool class that downloads
files from Wegent Backend to the sandbox environment via API.
"""

import json
import logging
import os
import re
import time
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

import httpx
from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

from shared.utils.attachment_block import build_sandbox_path

logger = logging.getLogger(__name__)

# Default API base URL for attachment downloads
DEFAULT_API_BASE_URL = "http://backend:8000"
_ATTACHMENT_DOWNLOAD_PATH = re.compile(
    r"^/api/attachments/(?P<attachment_id>\d+)/download/?$"
)


def _build_download_url(attachment_url: str, api_base_url: str) -> str:
    """Build a URL that accepts the task token available to sandbox tools."""
    attachment_id = _attachment_id_from_url(attachment_url)
    backend = urlsplit(api_base_url.rstrip("/"))
    executor_path = f"/api/attachments/{attachment_id}/executor-download"
    return urlunsplit((backend.scheme, backend.netloc, executor_path, "", ""))


def _attachment_id_from_url(attachment_url: str) -> int:
    """Extract an attachment ID from a supported Wegent download URL."""
    relative_url = (
        attachment_url if attachment_url.startswith("/") else f"/{attachment_url}"
    )
    parsed = urlsplit(
        attachment_url
        if attachment_url.startswith(("http://", "https://"))
        else relative_url
    )
    match = _ATTACHMENT_DOWNLOAD_PATH.fullmatch(parsed.path)
    if not match:
        raise ValueError("Only Wegent attachment download URLs are supported")
    return int(match.group("attachment_id"))


def _build_task_attachments_url(task_id: int, api_base_url: str) -> str:
    """Build the task-scoped metadata URL used to resolve the canonical path."""
    backend = urlsplit(api_base_url.rstrip("/"))
    path = f"/api/attachments/task/{task_id}/all"
    return urlunsplit((backend.scheme, backend.netloc, path, "", ""))


async def _resolve_attachment_sandbox_path(
    *,
    attachment_url: str,
    api_base_url: str,
    auth_token: str,
    task_id: int,
    timeout_seconds: int,
) -> str:
    """Resolve an attachment's canonical path from trusted Backend metadata."""
    if task_id <= 0:
        raise ValueError("Task ID is required to resolve the attachment path")

    attachment_id = _attachment_id_from_url(attachment_url)
    metadata_url = _build_task_attachments_url(task_id, api_base_url)
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.get(
            metadata_url,
            headers={"Authorization": f"Bearer {auth_token}"},
        )
        response.raise_for_status()

    payload = response.json()
    if not isinstance(payload, list):
        raise ValueError("Backend returned invalid attachment metadata")

    metadata = next(
        (
            item
            for item in payload
            if isinstance(item, dict) and int(item.get("id") or 0) == attachment_id
        ),
        None,
    )
    if metadata is None:
        raise ValueError(f"Attachment {attachment_id} does not belong to this task")

    filename = str(metadata.get("filename") or "attachment")
    subtask_id = int(metadata.get("subtask_id") or 0)
    sandbox_path = build_sandbox_path(task_id, subtask_id, filename)
    if not sandbox_path:
        raise ValueError("Attachment metadata is missing its owning subtask")
    return sandbox_path


class SandboxDownloadAttachmentInput(BaseModel):
    """Input schema for download_attachment tool."""

    attachment_url: str = Field(
        ...,
        description="Wegent attachment download URL (e.g., /api/attachments/123/download)",
    )
    timeout_seconds: Optional[int] = Field(
        default=300,
        description="Download timeout in seconds (default: 300)",
    )


# Import base class here - use try/except to handle both direct and dynamic loading
try:
    # Try relative import (for direct usage)
    from ._base import BaseSandboxTool
except ImportError:
    # Try absolute import (for dynamic loading as skill_pkg_sandbox)
    import sys

    # Get the package name dynamically
    package_name = __name__.rsplit(".", 1)[0]  # e.g., 'skill_pkg_sandbox'
    _base_module = sys.modules.get(f"{package_name}._base")
    if _base_module:
        BaseSandboxTool = _base_module.BaseSandboxTool
    else:
        raise ImportError(f"Cannot import _base from {package_name}")


class SandboxDownloadAttachmentTool(BaseSandboxTool):
    """Tool for downloading files from Wegent Backend to E2B sandbox.

    This tool downloads files from Wegent's attachment storage to the
    sandbox environment via the task-token attachment endpoint.
    """

    name: str = "download_attachment"
    display_name: str = "下载文件"
    description: str = """Download a file from Wegent attachment URL to sandbox.

Use this tool to download attachments from Wegent to the sandbox environment
for processing or editing.

Parameters:
- attachment_url (required): Wegent attachment URL (e.g., /api/attachments/123/download)
- timeout_seconds (optional): Download timeout in seconds (default: 300)

The destination is resolved from trusted attachment metadata and always uses
/home/user/{task_id}:executor:attachments/{subtask_id}/{filename}.

Returns:
- success: Whether the download succeeded
- file_path: Full path to the downloaded file in sandbox
- file_size: Size of the downloaded file in bytes
- message: Status message

Example:
{
  "attachment_url": "/api/attachments/123/download"
}
"""

    args_schema: type[BaseModel] = SandboxDownloadAttachmentInput

    # Configuration
    default_download_timeout: int = 300

    # Auth token - will be injected from context/config
    auth_token: str = ""
    api_base_url: str = ""

    def _run(
        self,
        attachment_url: str,
        timeout_seconds: Optional[int] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError(
            "SandboxDownloadAttachmentTool only supports async execution"
        )

    async def _arun(
        self,
        attachment_url: str,
        timeout_seconds: Optional[int] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Download file from Wegent Backend to sandbox.

        Args:
            attachment_url: Wegent attachment URL (e.g., /api/attachments/123/download)
            timeout_seconds: Download timeout in seconds
            run_manager: Callback manager

        Returns:
            JSON string with download result
        """
        start_time = time.time()
        effective_timeout = timeout_seconds or self.default_download_timeout

        logger.info(
            "[SandboxDownloadAttachmentTool] Downloading attachment: "
            f"timeout={effective_timeout}s"
        )

        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "attachment_url": attachment_url,
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(
                    f"[SandboxDownloadAttachmentTool] Failed to emit tool status: {e}"
                )

        try:
            api_base_url = self.api_base_url or os.getenv(
                "BACKEND_API_URL", DEFAULT_API_BASE_URL
            )
            api_base_url = api_base_url.rstrip("/")

            auth_token = self.auth_token
            if not auth_token:
                error_msg = "No authentication token available for download"
                result = self._format_error(
                    error_message=error_msg,
                    file_path="",
                    file_size=0,
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            save_path = await _resolve_attachment_sandbox_path(
                attachment_url=attachment_url,
                api_base_url=api_base_url,
                auth_token=auth_token,
                task_id=self.task_id,
                timeout_seconds=effective_timeout,
            )

            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info(
                "[SandboxDownloadAttachmentTool] Getting or creating sandbox..."
            )
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                logger.error(
                    f"[SandboxDownloadAttachmentTool] Failed to create sandbox: {error}"
                )
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    file_path="",
                    file_size=0,
                )
                await self._emit_tool_status("failed", error)
                return result

            # Create parent directories if needed
            parent_dir = os.path.dirname(save_path)
            if parent_dir and parent_dir != "/":
                try:
                    await sandbox.files.make_dir(parent_dir)
                    logger.info(
                        f"[SandboxDownloadAttachmentTool] Created directory: {parent_dir}"
                    )
                except Exception as e:
                    # Directory might already exist, that's okay
                    logger.debug(
                        f"[SandboxDownloadAttachmentTool] Directory creation skipped: {e}"
                    )

            # The attachment block exposes the browser download URL. Translate
            # that exact Wegent route to the executor route because sandbox tools
            # authenticate with a task token rather than a browser login token.
            download_url = _build_download_url(attachment_url, api_base_url)

            # Keep credentials and user-provided paths out of the command string.
            # E2B passes these values directly as process environment variables.
            curl_cmd = (
                "curl --silent --show-error --fail --location "
                '--header "Authorization: Bearer $WEGENT_ATTACHMENT_TOKEN" '
                '--output "$WEGENT_ATTACHMENT_SAVE_PATH" '
                '"$WEGENT_ATTACHMENT_DOWNLOAD_URL"'
            )

            logger.info("[SandboxDownloadAttachmentTool] Executing attachment download")

            # Execute curl command
            result_obj = await sandbox.commands.run(
                cmd=curl_cmd,
                cwd="/home/user",
                timeout=effective_timeout,
                envs={
                    "WEGENT_ATTACHMENT_TOKEN": auth_token,
                    "WEGENT_ATTACHMENT_SAVE_PATH": save_path,
                    "WEGENT_ATTACHMENT_DOWNLOAD_URL": download_url,
                },
            )

            execution_time = time.time() - start_time

            if result_obj.exit_code != 0:
                error_msg = f"Download failed: {result_obj.stderr or 'HTTP error or file not found'}"
                logger.error(f"[SandboxDownloadAttachmentTool] {error_msg}")
                result = self._format_error(
                    error_message=error_msg,
                    file_path=save_path,
                    file_size=0,
                    stderr=result_obj.stderr,
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Verify file was created and get its size
            try:
                file_info = await sandbox.files.get_info(save_path)
                file_size = file_info.size
            except Exception as e:
                error_msg = f"File was not created after download: {e}"
                logger.error(f"[SandboxDownloadAttachmentTool] {error_msg}")
                result = self._format_error(
                    error_message=error_msg,
                    file_path=save_path,
                    file_size=0,
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            response = {
                "success": True,
                "file_path": save_path,
                "file_size": file_size,
                "message": "File downloaded successfully",
                "execution_time": execution_time,
                "sandbox_id": sandbox.sandbox_id,
            }

            logger.info(
                f"[SandboxDownloadAttachmentTool] Download successful: "
                f"file_path={save_path}, file_size={file_size}"
            )

            # Emit success status
            await self._emit_tool_status(
                "completed",
                f"File downloaded successfully ({file_size} bytes)",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[SandboxDownloadAttachmentTool] E2B SDK import error: {e}")
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            result = self._format_error(
                error_message=error_msg,
                file_path="",
                file_size=0,
            )
            await self._emit_tool_status("failed", error_msg)
            return result
        except Exception as e:
            logger.error(
                f"[SandboxDownloadAttachmentTool] Download failed: {e}", exc_info=True
            )
            error_msg = f"Failed to download file: {e}"
            result = self._format_error(
                error_message=error_msg,
                file_path="",
                file_size=0,
            )
            await self._emit_tool_status("failed", error_msg)
            return result
