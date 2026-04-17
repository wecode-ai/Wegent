# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk Knowledge Tool Provider.

This module provides the DingTalkKnowledgeProvider class that creates
tools for downloading DingTalk documents and uploading them as attachments
to Wegent.

Tools provided:
- download_dingtalk_document: Download DingTalk document from download URL in sandbox and upload as attachment
- save_dingtalk_content: Save DingTalk online document content to file in sandbox and upload as attachment

Workflow:
1. Call MCP tool (get_document_info, download_file, get_document_content) to get document info
2. Call provider tool with download_url/content and file_extension to upload
"""

import json
import logging
import os
import re
import secrets
import shlex
import time
from typing import Any, Optional
from urllib.parse import urlparse

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from chat_shell.chat_shell.skills import SkillToolContext, SkillToolProvider
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

# Maximum file size for uploads (default 100MB)
ATTACHMENT_MAX_BYTES = int(os.getenv("ATTACHMENT_MAX_BYTES", "104857600"))


class DingTalkKnowledgeProvider(SkillToolProvider):
    """Tool provider for DingTalk Knowledge operations.

    This provider creates tools that help upload DingTalk documents
    to Wegent knowledge bases. It handles:
    - Document download from DingTalk export URL in sandbox
    - Content saving to file in sandbox
    - Upload as Wegent attachment
    """

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md."""
        return "dingtalk_knowledge"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create."""
        return ["download_dingtalk_document", "save_dingtalk_content"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a DingTalk Knowledge tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies
            tool_config: Optional configuration

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is unknown
        """
        logger.info(
            f"[DingTalkKnowledgeProvider] Creating tool: {tool_name}, "
            f"task_id={context.task_id}, user_id={context.user_id}"
        )

        if tool_name == "download_dingtalk_document":
            return DownloadDingTalkDocumentTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                user_id=context.user_id,
                user_name=context.user_name,
                auth_token=context.auth_token,
                ws_emitter=context.ws_emitter,
            )
        elif tool_name == "save_dingtalk_content":
            return SaveDingTalkContentTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                user_id=context.user_id,
                user_name=context.user_name,
                auth_token=context.auth_token,
                ws_emitter=context.ws_emitter,
            )
        else:
            raise ValueError(f"Unknown tool: {tool_name}")

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate tool configuration.

        Args:
            tool_config: Configuration to validate

        Returns:
            True if valid
        """
        return True


class DownloadDingTalkDocumentInput(BaseModel):
    """Input schema for download_dingtalk_document tool."""

    download_url: str = Field(
        ...,
        description="Download URL obtained from DingTalk MCP download_file tool (contains download_token)",
    )
    file_extension: str = Field(
        ...,
        description="File extension from get_document_info (e.g., 'docx', 'xlsx', 'pdf')",
    )
    filename: Optional[str] = Field(
        default=None,
        description="Optional filename. If not provided, will use 'dingtalk_document.{file_extension}'",
    )
    timeout_seconds: Optional[int] = Field(
        default=300,
        description="Download timeout in seconds",
    )


class SaveDingTalkContentInput(BaseModel):
    """Input schema for save_dingtalk_content tool."""

    content: str = Field(
        ...,
        description="Document content obtained from DingTalk MCP get_document_content tool (markdown format)",
    )
    file_extension: str = Field(
        ...,
        description="File extension from get_document_info. For online documents (adoc), use 'md' since content is markdown",
    )
    filename: Optional[str] = Field(
        default=None,
        description="Optional filename. If not provided, will use 'dingtalk_document.{file_extension}'",
    )
    timeout_seconds: Optional[int] = Field(
        default=300,
        description="Operation timeout in seconds",
    )


def _validate_filename(filename: str) -> str:
    """Validate and sanitize filename to prevent path traversal.

    Args:
        filename: Original filename

    Returns:
        Sanitized filename

    Raises:
        ValueError: If filename contains invalid characters
    """
    # Reject path separators and control characters
    if re.search(r"[\/\x00-\x1f\x7f]", filename):
        raise ValueError(
            "Invalid filename: contains path separators or control characters"
        )
    # Reject parent directory references
    if ".." in filename:
        raise ValueError("Invalid filename: contains parent directory reference")
    # Strip any leading/trailing whitespace
    return filename.strip()


def _generate_temp_dir_name() -> str:
    """Generate a unique temporary directory name.

    Returns:
        Unique directory path in /tmp
    """
    return f"/tmp/dingtalk_{secrets.token_hex(16)}"


class _DingTalkSandboxUploadTool(BaseTool):
    """Base class for DingTalk sandbox upload tools.

    Provides common functionality for:
    - Sandbox acquisition and validation
    - Temporary directory management
    - File upload via curl
    - Response parsing and status emission
    - Cleanup
    """

    task_id: int = 0
    subtask_id: int = 0
    user_id: int = 0
    user_name: Optional[str] = None
    auth_token: str = ""
    ws_emitter: Any = None

    @trace_async(
        span_name="PrepareSandbox",
        tracer_name="dingtalk_knowledge",
        extract_attributes=lambda self, effective_timeout: {
            "task_id": self.task_id,
            "user_id": self.user_id,
            "timeout": effective_timeout,
        },
    )
    async def _prepare_sandbox(self, effective_timeout: int) -> tuple[Any, str]:
        """Acquire sandbox and setup temp directory.

        Args:
            effective_timeout: Timeout for operations

        Returns:
            Tuple of (sandbox, temp_dir)

        Raises:
            RuntimeError: If sandbox creation fails
        """
        from chat_shell.chat_shell.tools.sandbox import SandboxManager

        logger.info(
            "[_prepare_sandbox] Starting sandbox preparation for task_id=%s, user_id=%s",
            self.task_id,
            self.user_id,
        )

        # Get user info for sandbox manager
        effective_user_name = self.user_name or f"user_{self.user_id}"
        logger.info("[_prepare_sandbox] Using user_name=%s", effective_user_name)

        # Get or create sandbox manager singleton
        sandbox_manager = SandboxManager.get_instance(
            task_id=self.task_id,
            user_id=self.user_id,
            user_name=effective_user_name,
        )
        logger.info("[_prepare_sandbox] Got SandboxManager instance")

        # Get or create sandbox - use ClaudeCode as default shell type
        # Note: timeout is passed via SandboxManager.get_instance(), not get_or_create_sandbox()
        logger.info(
            "[_prepare_sandbox] Calling get_or_create_sandbox with shell_type=ClaudeCode"
        )
        sandbox, error = await sandbox_manager.get_or_create_sandbox(
            shell_type="ClaudeCode",
            workspace_ref=None,
        )

        if error:
            logger.error("[_prepare_sandbox] Failed to create sandbox: %s", error)
            raise RuntimeError(f"Failed to create sandbox: {error}")

        logger.info("[_prepare_sandbox] Sandbox created successfully")

        # Generate unique temp directory
        temp_dir = _generate_temp_dir_name()
        logger.info("[_prepare_sandbox] Created temp_dir=%s", temp_dir)

        # Create temp directory
        await sandbox.files.make_dir(temp_dir)
        logger.info("[_prepare_sandbox] Temp directory created in sandbox")

        return sandbox, temp_dir

    @trace_async(
        span_name="UploadAndReturn",
        tracer_name="dingtalk_knowledge",
        extract_attributes=lambda self, sandbox, save_path, filename, file_size, temp_dir, start_time, effective_timeout: {
            "filename": filename,
            "file_size": file_size,
            "task_id": self.task_id,
        },
    )
    async def _upload_and_return(
        self,
        sandbox: Any,
        save_path: str,
        filename: str,
        file_size: int,
        temp_dir: str,
        start_time: float,
        effective_timeout: int,
    ) -> str:
        """Upload file to Wegent and return result.

        Args:
            sandbox: Sandbox instance
            save_path: Path to file in sandbox
            filename: Original filename
            file_size: Size of file in bytes
            temp_dir: Temp directory path for cleanup
            start_time: Start time for execution time calculation
            effective_timeout: Timeout for operations

        Returns:
            JSON response string
        """
        # Validate file size before upload
        if file_size > ATTACHMENT_MAX_BYTES:
            raise RuntimeError(
                f"File size ({file_size} bytes) exceeds maximum allowed size "
                f"({ATTACHMENT_MAX_BYTES} bytes)"
            )

        # Upload to Wegent
        api_base_url = os.getenv("BACKEND_API_URL", "http://backend:8000").rstrip("/")
        upload_url = f"{api_base_url}/api/attachments/upload"

        if not self.auth_token:
            raise RuntimeError("No authentication token available")

        # Build curl command for upload using argument list (safer than shell string)
        # Use -sS to show errors but suppress progress, and -w to capture HTTP status code
        upload_curl_cmd = [
            "curl",
            "-sS",
            "-X",
            "POST",
            "-H",
            f"Authorization: Bearer {self.auth_token}",
            "-F",
            f"file=@{save_path}",
            "-w",
            "\n%{http_code}",
            upload_url,
        ]

        logger.info("[%s] Uploading to Wegent", self.__class__.__name__)

        try:
            upload_result = await sandbox.commands.run(
                cmd=upload_curl_cmd,
                cwd="/home/user",
                timeout=effective_timeout,
            )

            if upload_result.exit_code != 0:
                raise RuntimeError(
                    f"Upload failed: {upload_result.stderr or 'Unknown error'}"
                )

            # Parse response - extract HTTP status code from last line
            output_lines = upload_result.stdout.strip().split("\n")
            if len(output_lines) < 2:
                raise RuntimeError("Invalid upload response format")

            http_status = int(output_lines[-1])
            response_body = "\n".join(output_lines[:-1])

            # Parse JSON body
            try:
                api_response = json.loads(response_body)
            except json.JSONDecodeError as e:
                raise RuntimeError(f"Failed to parse upload response: {e}") from e

            # Check HTTP status code for success (2xx)
            if 200 <= http_status < 300:
                attachment_id = api_response.get("id")
                if not attachment_id:
                    raise RuntimeError("No attachment_id in response")

                execution_time = time.time() - start_time

                response = {
                    "success": True,
                    "attachment_id": attachment_id,
                    "filename": filename,
                    "file_size": file_size,
                    "download_url": f"/api/attachments/{attachment_id}/download",
                    "message": "Document uploaded successfully",
                    "execution_time": execution_time,
                }

                logger.info(
                    "[%s] Success: attachment_id=%s",
                    self.__class__.__name__,
                    attachment_id,
                )

                # Emit success status
                if self.ws_emitter:
                    await self.ws_emitter.emit_tool_call(
                        task_id=self.task_id,
                        tool_name=self.name,
                        tool_input={"filename": filename},
                        status="completed",
                        output=response,
                    )

                return json.dumps(response, ensure_ascii=False, indent=2)
            else:
                # Non-2xx status code - extract error detail
                error_detail = api_response.get("detail") or upload_result.stderr
                # Handle case where error_detail is a dict
                if isinstance(error_detail, dict):
                    error_detail = error_detail.get("message") or json.dumps(
                        error_detail
                    )
                if not error_detail:
                    error_detail = f"HTTP {http_status}: Unknown error"
                raise RuntimeError(f"Upload API error: {error_detail}")

        finally:
            # Cleanup temp directory - always run on success and exceptions
            try:
                await sandbox.commands.run(
                    cmd=["rm", "-rf", temp_dir],
                    cwd="/home/user",
                )
                logger.info(
                    "[%s] Cleaned up temp_dir=%s", self.__class__.__name__, temp_dir
                )
            except Exception as e:
                logger.error(
                    "[%s] Failed to cleanup temp_dir=%s: %s",
                    self.__class__.__name__,
                    temp_dir,
                    e,
                )

    @trace_async(
        span_name="HandleError",
        tracer_name="dingtalk_knowledge",
        extract_attributes=lambda self, filename, error: {
            "filename": filename,
            "error_type": type(error).__name__,
            "task_id": self.task_id,
        },
    )
    async def _handle_error(self, filename: str, error: Exception) -> str:
        """Handle error and return error response.

        Args:
            filename: Filename being processed
            error: Exception that occurred

        Returns:
            JSON error response string
        """
        logger.error("[%s] Error: %s", self.__class__.__name__, error, exc_info=True)

        error_response = {
            "success": False,
            "attachment_id": None,
            "filename": filename,
            "file_size": 0,
            "download_url": "",
            "error": str(error),
        }

        if self.ws_emitter:
            await self.ws_emitter.emit_tool_call(
                task_id=self.task_id,
                tool_name=self.name,
                tool_input={"filename": filename},
                status="failed",
                error=str(error),
            )

        return json.dumps(error_response, ensure_ascii=False, indent=2)


class DownloadDingTalkDocumentTool(_DingTalkSandboxUploadTool):
    """Tool for downloading DingTalk document and uploading as Wegent attachment.

    This tool:
    1. Downloads the document from the provided download URL in sandbox
    2. Uploads it to Wegent as an attachment
    3. Returns the attachment_id for use in knowledge base
    """

    name: str = "download_dingtalk_document"
    display_name: str = "下载钉钉文档"
    description: str = """Download a DingTalk document from download URL and upload as Wegent attachment.

This tool downloads a DingTalk document using the download URL obtained from DingTalk MCP's download_file tool,
then uploads it to Wegent as an attachment for use in knowledge base.

Prerequisites:
1. Call DingTalk MCP's get_document_info to get document metadata (including file_extension)
2. Call DingTalk MCP's download_file to get the download_url with token
3. Then call this tool with the download_url and file_extension

Parameters:
- download_url (required): Download URL from DingTalk MCP download_file tool (contains download_token)
- file_extension (required): File extension from get_document_info (e.g., 'docx', 'xlsx', 'pdf')
- filename (optional): Custom filename. If not provided, uses 'dingtalk_document.{file_extension}'
- timeout_seconds (optional): Download timeout (default: 300)

Returns:
- success: Whether the operation succeeded
- attachment_id: ID of the uploaded attachment
- filename: Name of the file
- file_size: Size in bytes
- download_url: Relative URL for downloading
- error: Error message if failed

Example:
```
# Step 1: Get document info
dingtalk-docs.get_document_info(document_id="nYMoOje9")
# Returns: {"name": "产品需求", "file_extension": "docx", ...}

# Step 2: Get download URL (use nodeId for docs)
dingtalk-docs.download_file(nodeId="nYMoOje9")
# Returns: {"download_url": "https://...", "download_token": "..."}

# Step 3: Download and upload in sandbox
dingtalk_knowledge.download_dingtalk_document(
    download_url="https://alidocs.dingtalk.com/...",
    file_extension="docx",
    filename="产品需求.docx"
)
```

Note: This tool requires sandbox access. Make sure the sandbox skill is loaded.
"""

    args_schema: type[BaseModel] = DownloadDingTalkDocumentInput

    def _run(
        self,
        download_url: str,
        file_extension: str,
        filename: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
    ) -> str:
        """Synchronous execution - not implemented."""
        raise NotImplementedError(
            "DownloadDingTalkDocumentTool only supports async execution"
        )

    @trace_async(
        span_name="DownloadDingTalkDocument",
        tracer_name="dingtalk_knowledge",
        extract_attributes=lambda self, download_url, file_extension, filename=None, timeout_seconds=None: {
            "download_url": str(urlparse(download_url)._replace(query="").geturl()),
            "filename": filename or f"dingtalk_document.{file_extension.lstrip('.')}",
            "file_extension": file_extension,
            "timeout_seconds": timeout_seconds or 300,
        },
    )
    async def _arun(
        self,
        download_url: str,
        file_extension: str,
        filename: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
    ) -> str:
        """Download DingTalk document and upload as attachment."""
        start_time = time.time()
        effective_timeout = timeout_seconds or 300

        # Build filename from extension if not provided
        if not filename:
            # Remove leading dot from extension if present
            ext = file_extension.lstrip(".")
            filename = f"dingtalk_document.{ext}"
        else:
            # Ensure filename has the correct extension
            ext = file_extension.lstrip(".")
            if not filename.endswith(f".{ext}"):
                filename = f"{filename}.{ext}"

        logger.info("[DownloadDingTalkDocumentTool] Downloading filename=%s", filename)

        # Validate filename
        try:
            filename = _validate_filename(filename)
        except ValueError as e:
            return await self._handle_error(filename, e)

        # Emit status update - sanitize download_url by removing query params
        if self.ws_emitter:
            try:
                sanitized_url = urlparse(download_url)._replace(query="").geturl()
                file_ext = os.path.splitext(filename)[1].lstrip(".")
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "filename": filename,
                        "extension": file_ext,
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning("Failed to emit tool status: %s", e)

        try:
            # Prepare sandbox
            sandbox, temp_dir = await self._prepare_sandbox(effective_timeout)

            save_path = f"{temp_dir}/{filename}"

            # Download file using curl with argument list (safer than shell string)
            # Add --max-filesize and --max-time for safety
            curl_cmd = [
                "curl",
                "-s",
                "-f",
                "-L",
                "--max-filesize",
                str(ATTACHMENT_MAX_BYTES),
                "--max-time",
                str(effective_timeout),
                "-o",
                save_path,
                "--",
                download_url,
            ]

            logger.info(
                "[DownloadDingTalkDocumentTool] Executing download: curl -o %s ...",
                shlex.quote(save_path),
            )

            result = await sandbox.commands.run(
                cmd=curl_cmd,
                cwd="/home/user",
                timeout=effective_timeout,
            )

            if result.exit_code != 0:
                raise RuntimeError(f"Download failed: {result.stderr or 'HTTP error'}")

            # Verify file exists and get size
            file_info = await sandbox.files.get_info(save_path)
            file_size = file_info.size

            logger.info("[DownloadDingTalkDocumentTool] Downloaded %s bytes", file_size)

            # Upload and return result
            return await self._upload_and_return(
                sandbox=sandbox,
                save_path=save_path,
                filename=filename,
                file_size=file_size,
                temp_dir=temp_dir,
                start_time=start_time,
                effective_timeout=effective_timeout,
            )

        except Exception as e:
            return await self._handle_error(filename, e)


class SaveDingTalkContentTool(_DingTalkSandboxUploadTool):
    """Tool for saving DingTalk online document content and uploading as attachment.

    This tool is used for online documents (like adoc) that cannot be downloaded directly.
    It:
    1. Saves the content obtained from get_document_content to a file in sandbox
    2. Uploads it to Wegent as an attachment
    3. Returns the attachment_id for use in knowledge base
    """

    name: str = "save_dingtalk_content"
    display_name: str = "保存钉钉文档内容"
    description: str = """Save DingTalk online document content to a file and upload as Wegent attachment.

This tool is for online documents (like adoc) that cannot be downloaded via download_file.
It saves the content obtained from DingTalk MCP's get_document_content tool to a file,
then uploads it to Wegent as an attachment.

Prerequisites:
1. Call DingTalk MCP's get_document_info to get document metadata (including file_extension)
2. Call DingTalk MCP's download_file - if it fails with "在线文档不支持直接下载"
3. Call DingTalk MCP's get_document_content to get the document content
4. Then call this tool with the content and file_extension

Parameters:
- content (required): Document content from DingTalk MCP get_document_content tool (markdown format)
- file_extension (required): File extension from get_document_info. For online docs (adoc), use 'md' since content is markdown
- filename (optional): Custom filename. If not provided, uses 'dingtalk_document.{file_extension}'
- timeout_seconds (optional): Operation timeout (default: 300)

Returns:
- success: Whether the operation succeeded
- attachment_id: ID of the uploaded attachment
- filename: Name of the file
- file_size: Size in bytes
- download_url: Relative URL for downloading
- error: Error message if failed

Example:
```
# Step 1: Get document info
dingtalk-docs.get_document_info(document_id="nYMoOje9")
# Returns: {"name": "产品需求", "file_extension": "adoc", ...}

# Step 2: Try download_file (will fail for online docs)
dingtalk-docs.download_file(nodeId="nYMoOje9")
# Returns error: "在线文档不支持直接下载。请使用 get_document_content 工具获取文档内容。"

# Step 3: Get content (returns markdown format)
dingtalk-docs.get_document_content(nodeId="nYMoOje9")
# Returns: {"markdown": "# Title\n\nContent...", ...}

# Step 4: Save content and upload in sandbox (use 'md' extension for adoc content)
dingtalk_knowledge.save_dingtalk_content(
    content="# Title\n\nContent...",
    file_extension="md",  # Use 'md' for adoc content since it's markdown
    filename="产品需求.md"
)
```

Note: This tool requires sandbox access. Make sure the sandbox skill is loaded.
"""

    args_schema: type[BaseModel] = SaveDingTalkContentInput

    def _run(
        self,
        content: str,
        file_extension: str,
        filename: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
    ) -> str:
        """Synchronous execution - not implemented."""
        raise NotImplementedError(
            "SaveDingTalkContentTool only supports async execution"
        )

    @trace_async(
        span_name="SaveDingTalkContent",
        tracer_name="dingtalk_knowledge",
        extract_attributes=lambda self, content, file_extension, filename=None, timeout_seconds=None: {
            "filename": filename or f"dingtalk_document.{file_extension.lstrip('.')}",
            "file_extension": file_extension,
            "content_length": len(content),
            "timeout_seconds": timeout_seconds or 300,
        },
    )
    async def _arun(
        self,
        content: str,
        file_extension: str,
        filename: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
    ) -> str:
        """Save content to file and upload as attachment."""
        start_time = time.time()
        effective_timeout = timeout_seconds or 300

        logger.info(
            "[SaveDingTalkContentTool._arun] Starting with file_extension=%s, content_length=%s",
            file_extension,
            len(content),
        )

        # Build filename from extension if not provided
        if not filename:
            # Remove leading dot from extension if present
            ext = file_extension.lstrip(".")
            filename = f"dingtalk_document.{ext}"
        else:
            # Ensure filename has the correct extension
            ext = file_extension.lstrip(".")
            if not filename.endswith(f".{ext}"):
                filename = f"{filename}.{ext}"

        logger.info(
            "[SaveDingTalkContentTool] Saving content, filename=%s, content_length=%s",
            filename,
            len(content),
        )

        # Validate filename
        try:
            filename = _validate_filename(filename)
        except ValueError as e:
            return await self._handle_error(filename, e)

        # Emit status update
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={"filename": filename, "content_length": len(content)},
                    status="running",
                )
            except Exception as e:
                logger.warning("Failed to emit tool status: %s", e)

        try:
            logger.info("[SaveDingTalkContentTool._arun] Preparing to start sandbox...")

            # Fail-fast size check before writing
            content_bytes = content.encode("utf-8")
            if len(content_bytes) > ATTACHMENT_MAX_BYTES:
                raise RuntimeError(
                    f"Content size ({len(content_bytes)} bytes) exceeds maximum allowed size "
                    f"({ATTACHMENT_MAX_BYTES} bytes)"
                )

            # Prepare sandbox
            sandbox, temp_dir = await self._prepare_sandbox(effective_timeout)
            logger.info(
                "[SaveDingTalkContentTool._arun] Sandbox ready, temp_dir=%s", temp_dir
            )

            save_path = f"{temp_dir}/{filename}"

            # Write content directly using sandbox.files.write
            logger.info("[SaveDingTalkContentTool] Writing content to file")
            try:
                await sandbox.files.write(save_path, content_bytes)
            except Exception as e:
                raise RuntimeError(f"Failed to write content: {e}") from e

            # Verify file exists and get size
            file_info = await sandbox.files.get_info(save_path)
            file_size = file_info.size

            logger.info("[SaveDingTalkContentTool] Saved %s bytes", file_size)

            # Upload and return result
            return await self._upload_and_return(
                sandbox=sandbox,
                save_path=save_path,
                filename=filename,
                file_size=file_size,
                temp_dir=temp_dir,
                start_time=start_time,
                effective_timeout=effective_timeout,
            )

        except Exception as e:
            return await self._handle_error(filename, e)
