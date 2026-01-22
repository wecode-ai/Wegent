# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox attachment upload tool using curl command.

This module provides the SandboxUploadAttachmentTool class that uploads
files from the sandbox environment to Wegent Backend via API.
"""

import json
import logging
import os
import time
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Default API base URL for attachment uploads
DEFAULT_API_BASE_URL = "http://backend:8000"

# Maximum file size for uploads (100 MB)
MAX_UPLOAD_SIZE = 100 * 1024 * 1024


class SandboxUploadAttachmentInput(BaseModel):
    """Input schema for sandbox_upload_attachment tool."""

    file_path: str = Field(
        ...,
        description="Path to the file in sandbox to upload",
    )
    timeout_seconds: Optional[int] = Field(
        default=300,
        description="Upload timeout in seconds (default: 300)",
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


class SandboxUploadAttachmentTool(BaseSandboxTool):
    """Tool for uploading files from E2B sandbox to Wegent Backend.

    This tool uploads files from the sandbox environment to Wegent's
    attachment storage via the /api/attachments/upload endpoint.
    """

    name: str = "sandbox_upload_attachment"
    display_name: str = "上传文件"
    description: str = """Upload a file from sandbox to Wegent and get a download URL.

Use this tool to upload generated files (documents, reports, etc.) from the sandbox
so that users can download them.

Parameters:
- file_path (required): Path to the file in sandbox to upload
- timeout_seconds (optional): Upload timeout in seconds (default: 300)

Returns:
- success: Whether the upload succeeded
- attachment_id: ID of the uploaded attachment
- filename: Name of the uploaded file
- file_size: Size of the file in bytes
- mime_type: MIME type of the file
- download_url: Relative URL for downloading the file (e.g., /api/attachments/123/download)
- message: Status message

Example:
{
  "file_path": "/home/user/documents/report.pdf"
}

After successful upload, you can provide the download_url to the user:
"Document generation completed! [Click to Download](/api/attachments/123/download)"
"""

    args_schema: type[BaseModel] = SandboxUploadAttachmentInput

    # Configuration
    max_upload_size: int = MAX_UPLOAD_SIZE
    default_upload_timeout: int = 300

    # Auth token - will be injected from context/config
    auth_token: str = ""
    api_base_url: str = ""

    def _run(
        self,
        file_path: str,
        timeout_seconds: Optional[int] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError(
            "SandboxUploadAttachmentTool only supports async execution"
        )

    async def _arun(
        self,
        file_path: str,
        timeout_seconds: Optional[int] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Upload file from sandbox to Wegent Backend.

        Args:
            file_path: Path to the file in sandbox to upload
            timeout_seconds: Upload timeout in seconds
            run_manager: Callback manager

        Returns:
            JSON string with upload result including download_url
        """
        start_time = time.time()
        effective_timeout = timeout_seconds or self.default_upload_timeout

        logger.info(
            f"[SandboxUploadAttachmentTool] Uploading file: {file_path}, "
            f"timeout={effective_timeout}s"
        )

        # Emit status update via WebSocket if available
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={"file_path": file_path},
                    status="running",
                )
            except Exception as e:
                logger.warning(
                    f"[SandboxUploadAttachmentTool] Failed to emit tool status: {e}"
                )

        try:
            # Get sandbox manager from base class
            sandbox_manager = self._get_sandbox_manager()

            # Get or create sandbox
            logger.info(f"[SandboxUploadAttachmentTool] Getting or creating sandbox...")
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
            )

            if error:
                logger.error(
                    f"[SandboxUploadAttachmentTool] Failed to create sandbox: {error}"
                )
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                    attachment_id=None,
                    filename="",
                    file_size=0,
                    download_url="",
                )
                await self._emit_tool_status("failed", error)
                return result

            # Normalize path
            if not file_path.startswith("/"):
                file_path = f"/home/user/{file_path}"

            # First check if file exists and get its size
            logger.info(
                f"[SandboxUploadAttachmentTool] Checking file info in sandbox {sandbox.sandbox_id}"
            )

            try:
                file_info = await sandbox.files.get_info(file_path)
            except Exception as e:
                logger.warning(
                    f"[SandboxUploadAttachmentTool] File not found: {file_path}"
                )
                error_msg = f"File not found: {file_path}"
                result = self._format_error(
                    error_message=error_msg,
                    attachment_id=None,
                    filename="",
                    file_size=0,
                    download_url="",
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Check file size
            if file_info.size > self.max_upload_size:
                max_size_mb = self.max_upload_size / (1024 * 1024)
                error_msg = (
                    f"File too large: {file_info.size} bytes (max: {max_size_mb} MB)"
                )
                result = self._format_error(
                    error_message=error_msg,
                    attachment_id=None,
                    filename=os.path.basename(file_path),
                    file_size=file_info.size,
                    download_url="",
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Get API base URL and auth token
            api_base_url = self.api_base_url or os.getenv(
                "BACKEND_API_URL", DEFAULT_API_BASE_URL
            )
            api_base_url = api_base_url.rstrip("/")

            # Build curl command to upload file
            # The auth token should be passed from the context
            auth_token = self.auth_token
            if not auth_token:
                error_msg = "No authentication token available for upload"
                result = self._format_error(
                    error_message=error_msg,
                    attachment_id=None,
                    filename=os.path.basename(file_path),
                    file_size=file_info.size,
                    download_url="",
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            upload_url = f"{api_base_url}/api/attachments/upload"

            # Build curl command
            curl_cmd = (
                f"curl -s -X POST "
                f'-H "Authorization: Bearer {auth_token}" '
                f'-F "file=@{file_path}" '
                f'"{upload_url}"'
            )

            logger.info(
                f"[SandboxUploadAttachmentTool] Executing upload via curl to {upload_url}"
            )

            # Execute curl command
            result_obj = await sandbox.commands.run(
                cmd=curl_cmd,
                cwd="/home/user",
                timeout=effective_timeout,
            )

            execution_time = time.time() - start_time

            if result_obj.exit_code != 0:
                error_msg = f"Upload failed: {result_obj.stderr or 'Unknown error'}"
                logger.error(f"[SandboxUploadAttachmentTool] {error_msg}")
                result = self._format_error(
                    error_message=error_msg,
                    attachment_id=None,
                    filename=os.path.basename(file_path),
                    file_size=file_info.size,
                    download_url="",
                    stderr=result_obj.stderr,
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Parse JSON response from curl
            try:
                api_response = json.loads(result_obj.stdout)
            except json.JSONDecodeError as e:
                error_msg = f"Failed to parse API response: {e}"
                logger.error(
                    f"[SandboxUploadAttachmentTool] {error_msg}, stdout: {result_obj.stdout}"
                )
                result = self._format_error(
                    error_message=error_msg,
                    attachment_id=None,
                    filename=os.path.basename(file_path),
                    file_size=file_info.size,
                    download_url="",
                    raw_response=result_obj.stdout[:500],
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Check for API error response
            if "detail" in api_response:
                error_detail = api_response["detail"]
                if isinstance(error_detail, dict):
                    error_msg = error_detail.get("message", str(error_detail))
                else:
                    error_msg = str(error_detail)
                logger.error(f"[SandboxUploadAttachmentTool] API error: {error_msg}")
                result = self._format_error(
                    error_message=f"Upload API error: {error_msg}",
                    attachment_id=None,
                    filename=os.path.basename(file_path),
                    file_size=file_info.size,
                    download_url="",
                )
                await self._emit_tool_status("failed", error_msg)
                return result

            # Extract attachment info from response
            attachment_id = api_response.get("id")
            filename = api_response.get("filename", os.path.basename(file_path))
            file_size = api_response.get("file_size", file_info.size)
            mime_type = api_response.get("mime_type", "application/octet-stream")

            # Build download URL
            download_url = f"/api/attachments/{attachment_id}/download"

            response = {
                "success": True,
                "attachment_id": attachment_id,
                "filename": filename,
                "file_size": file_size,
                "mime_type": mime_type,
                "download_url": download_url,
                "message": "File uploaded successfully",
                "execution_time": execution_time,
                "sandbox_id": sandbox.sandbox_id,
            }

            logger.info(
                f"[SandboxUploadAttachmentTool] Upload successful: "
                f"attachment_id={attachment_id}, download_url={download_url}"
            )

            # Emit success status
            await self._emit_tool_status(
                "completed",
                f"File uploaded successfully ({file_size} bytes)",
                response,
            )

            return json.dumps(response, ensure_ascii=False, indent=2)

        except ImportError as e:
            logger.error(f"[SandboxUploadAttachmentTool] E2B SDK import error: {e}")
            error_msg = "E2B SDK not available. Please install e2b-code-interpreter."
            result = self._format_error(
                error_message=error_msg,
                attachment_id=None,
                filename="",
                file_size=0,
                download_url="",
            )
            await self._emit_tool_status("failed", error_msg)
            return result
        except Exception as e:
            logger.error(
                f"[SandboxUploadAttachmentTool] Upload failed: {e}", exc_info=True
            )
            error_msg = f"Failed to upload file: {e}"
            result = self._format_error(
                error_message=error_msg,
                attachment_id=None,
                filename="",
                file_size=0,
                download_url="",
            )
            await self._emit_tool_status("failed", error_msg)
            return result
