# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk Knowledge Tool Provider.

This module provides the DingTalkKnowledgeProvider class that creates
tools for downloading DingTalk documents and uploading them as attachments
to Wegent.

Tools provided:
- download_dingtalk_document: Download DingTalk document from download URL and upload as attachment
- save_dingtalk_content: Save DingTalk online document content to file and upload as attachment
"""

import json
import logging
import os
import time
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from chat_shell.chat_shell.skills import SkillToolContext, SkillToolProvider

logger = logging.getLogger(__name__)


class DingTalkKnowledgeProvider(SkillToolProvider):
    """Tool provider for DingTalk Knowledge operations.

    This provider creates tools that help upload DingTalk documents
    to Wegent knowledge bases. It handles:
    - Document download from DingTalk export URL
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
                auth_token=context.auth_token,
                ws_emitter=context.ws_emitter,
            )
        elif tool_name == "save_dingtalk_content":
            return SaveDingTalkContentTool(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                user_id=context.user_id,
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
    filename: str = Field(
        ...,
        description="Filename to save the document (e.g., 'document.docx')",
    )
    timeout_seconds: Optional[int] = Field(
        default=300,
        description="Download timeout in seconds",
    )


class DownloadDingTalkDocumentTool(BaseTool):
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
1. Call DingTalk MCP's get_document_info to get document metadata
2. Call DingTalk MCP's download_file to get the download_url with token
3. Then call this tool with the download_url

Parameters:
- download_url (required): Download URL from DingTalk MCP download_file tool (contains download_token)
- filename (required): Filename to save (e.g., 'document.docx', 'spreadsheet.xlsx')
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

# Step 2: Get download URL (use nodeId for docs)
dingtalk-docs.download_file(nodeId="nYMoOje9")
# Returns: {"download_url": "https://...", "download_token": "..."}

# Step 3: Download and upload
download_dingtalk_document(
    download_url="https://alidocs.dingtalk.com/...",
    filename="产品需求文档.docx"
)
```

Note: This tool requires sandbox access. Make sure the sandbox skill is loaded.
"""

    args_schema: type[BaseModel] = DownloadDingTalkDocumentInput

    task_id: int = 0
    subtask_id: int = 0
    user_id: int = 0
    auth_token: str = ""
    ws_emitter: Any = None

    def _run(
        self,
        download_url: str,
        filename: str,
        timeout_seconds: Optional[int] = None,
    ) -> str:
        """Synchronous execution - not implemented."""
        raise NotImplementedError(
            "DownloadDingTalkDocumentTool only supports async execution"
        )

    async def _arun(
        self,
        download_url: str,
        filename: str,
        timeout_seconds: Optional[int] = None,
    ) -> str:
        """Download DingTalk document and upload as attachment."""
        start_time = time.time()
        effective_timeout = timeout_seconds or 300

        logger.info(
            f"[DownloadDingTalkDocumentTool] Downloading from {download_url[:50]}..., "
            f"filename={filename}"
        )

        # Emit status update
        if self.ws_emitter:
            try:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={
                        "download_url": download_url[:50] + "...",
                        "filename": filename,
                    },
                    status="running",
                )
            except Exception as e:
                logger.warning(f"Failed to emit tool status: {e}")

        try:
            # Import sandbox manager
            from chat_shell.chat_shell.tools.sandbox import SandboxManager

            # Get user info for sandbox manager
            # We need user_name, try to get from context or use a default
            user_name = f"user_{self.user_id}"

            # Get or create sandbox manager singleton
            sandbox_manager = SandboxManager.get_instance(
                task_id=self.task_id,
                user_id=self.user_id,
                user_name=user_name,
            )

            # Get or create sandbox
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type="ClaudeCode",
                workspace_ref=None,
            )

            if error:
                raise RuntimeError(f"Failed to create sandbox: {error}")

            # Prepare paths
            temp_dir = f"/tmp/dingtalk_{int(time.time())}"
            save_path = f"{temp_dir}/{filename}"

            # Create temp directory
            await sandbox.files.make_dir(temp_dir)

            # Download file using curl
            curl_cmd = f"curl -s -f -L -o '{save_path}' '{download_url}'"

            logger.info(
                f"[DownloadDingTalkDocumentTool] Executing download: {curl_cmd[:80]}..."
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

            logger.info(f"[DownloadDingTalkDocumentTool] Downloaded {file_size} bytes")

            # Upload to Wegent
            api_base_url = os.getenv("BACKEND_API_URL", "http://backend:8000").rstrip(
                "/"
            )
            upload_url = f"{api_base_url}/api/attachments/upload"

            if not self.auth_token:
                raise RuntimeError("No authentication token available")

            # Build curl command for upload
            upload_curl_cmd = (
                f"curl -s -X POST "
                f'-H "Authorization: Bearer {self.auth_token}" '
                f'-F "file=@{save_path}" '
                f'"{upload_url}"'
            )

            logger.info(f"[DownloadDingTalkDocumentTool] Uploading to Wegent")

            upload_result = await sandbox.commands.run(
                cmd=upload_curl_cmd,
                cwd="/home/user",
                timeout=effective_timeout,
            )

            if upload_result.exit_code != 0:
                raise RuntimeError(
                    f"Upload failed: {upload_result.stderr or 'Unknown error'}"
                )

            # Parse response
            try:
                api_response = json.loads(upload_result.stdout)
            except json.JSONDecodeError as e:
                raise RuntimeError(f"Failed to parse upload response: {e}")

            if "detail" in api_response:
                error_detail = api_response["detail"]
                raise RuntimeError(f"Upload API error: {error_detail}")

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
                "message": "Document downloaded and uploaded successfully",
                "execution_time": execution_time,
            }

            logger.info(
                f"[DownloadDingTalkDocumentTool] Success: attachment_id={attachment_id}"
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

            # Cleanup temp directory
            try:
                await sandbox.commands.run(cmd=f"rm -rf {temp_dir}", cwd="/home/user")
            except Exception:
                pass

            return json.dumps(response, ensure_ascii=False, indent=2)

        except Exception as e:
            logger.error(f"[DownloadDingTalkDocumentTool] Error: {e}", exc_info=True)

            error_response = {
                "success": False,
                "attachment_id": None,
                "filename": filename,
                "file_size": 0,
                "download_url": "",
                "error": str(e),
            }

            if self.ws_emitter:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={"filename": filename},
                    status="failed",
                    error=str(e),
                )

            return json.dumps(error_response, ensure_ascii=False, indent=2)


class SaveDingTalkContentInput(BaseModel):
    """Input schema for save_dingtalk_content tool."""

    content: str = Field(
        ...,
        description="Document content obtained from DingTalk MCP get_document_content tool",
    )
    filename: str = Field(
        ...,
        description="Filename to save the content (e.g., 'document.md', 'document.txt')",
    )
    timeout_seconds: Optional[int] = Field(
        default=300,
        description="Operation timeout in seconds",
    )


class SaveDingTalkContentTool(BaseTool):
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
1. Call DingTalk MCP's get_document_info to get document metadata
2. Call DingTalk MCP's download_file - if it fails with "在线文档不支持直接下载"
3. Call DingTalk MCP's get_document_content to get the document content
4. Then call this tool with the content

Parameters:
- content (required): Document content from DingTalk MCP get_document_content tool
- filename (required): Filename to save (e.g., 'document.md', 'notes.txt')
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
# Step 1: Try download_file (will fail for online docs)
dingtalk-docs.download_file(nodeId="nYMoOje9")
# Returns error: "在线文档不支持直接下载。请使用 get_document_content 工具获取文档内容。"

# Step 2: Get content
dingtalk-docs.get_document_content(nodeId="nYMoOje9")
# Returns: {"content": "# Title\\n\\nContent..."}

# Step 3: Save content and upload
save_dingtalk_content(
    content="# Title\\n\\nContent...",
    filename="产品需求文档.md"
)
```

Note: This tool requires sandbox access. Make sure the sandbox skill is loaded.
"""

    args_schema: type[BaseModel] = SaveDingTalkContentInput

    task_id: int = 0
    subtask_id: int = 0
    user_id: int = 0
    auth_token: str = ""
    ws_emitter: Any = None

    def _run(
        self,
        content: str,
        filename: str,
        timeout_seconds: Optional[int] = None,
    ) -> str:
        """Synchronous execution - not implemented."""
        raise NotImplementedError(
            "SaveDingTalkContentTool only supports async execution"
        )

    async def _arun(
        self,
        content: str,
        filename: str,
        timeout_seconds: Optional[int] = None,
    ) -> str:
        """Save content to file and upload as attachment."""
        start_time = time.time()
        effective_timeout = timeout_seconds or 300

        logger.info(
            f"[SaveDingTalkContentTool] Saving content, filename={filename}, "
            f"content_length={len(content)}"
        )

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
                logger.warning(f"Failed to emit tool status: {e}")

        try:
            # Import sandbox manager
            from chat_shell.chat_shell.tools.sandbox import SandboxManager

            # Get user info for sandbox manager
            user_name = f"user_{self.user_id}"

            # Get or create sandbox manager singleton
            sandbox_manager = SandboxManager.get_instance(
                task_id=self.task_id,
                user_id=self.user_id,
                user_name=user_name,
            )

            # Get or create sandbox
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type="ClaudeCode",
                workspace_ref=None,
            )

            if error:
                raise RuntimeError(f"Failed to create sandbox: {error}")

            # Prepare paths
            temp_dir = f"/tmp/dingtalk_{int(time.time())}"
            save_path = f"{temp_dir}/{filename}"

            # Create temp directory
            await sandbox.files.make_dir(temp_dir)

            # Write content to file using Python in sandbox
            # Escape content for shell command
            escaped_content = content.replace("'", "'\"'\"'")
            python_cmd = f'python3 -c \'open("{save_path}", "w", encoding="utf-8").write("{escaped_content}")\''

            logger.info(f"[SaveDingTalkContentTool] Writing content to file")

            result = await sandbox.commands.run(
                cmd=python_cmd,
                cwd="/home/user",
                timeout=effective_timeout,
            )

            if result.exit_code != 0:
                raise RuntimeError(f"Failed to write content: {result.stderr}")

            # Verify file exists and get size
            file_info = await sandbox.files.get_info(save_path)
            file_size = file_info.size

            logger.info(f"[SaveDingTalkContentTool] Saved {file_size} bytes")

            # Upload to Wegent
            api_base_url = os.getenv("BACKEND_API_URL", "http://backend:8000").rstrip(
                "/"
            )
            upload_url = f"{api_base_url}/api/attachments/upload"

            if not self.auth_token:
                raise RuntimeError("No authentication token available")

            # Build curl command for upload
            upload_curl_cmd = (
                f"curl -s -X POST "
                f'-H "Authorization: Bearer {self.auth_token}" '
                f'-F "file=@{save_path}" '
                f'"{upload_url}"'
            )

            logger.info(f"[SaveDingTalkContentTool] Uploading to Wegent")

            upload_result = await sandbox.commands.run(
                cmd=upload_curl_cmd,
                cwd="/home/user",
                timeout=effective_timeout,
            )

            if upload_result.exit_code != 0:
                raise RuntimeError(
                    f"Upload failed: {upload_result.stderr or 'Unknown error'}"
                )

            # Parse response
            try:
                api_response = json.loads(upload_result.stdout)
            except json.JSONDecodeError as e:
                raise RuntimeError(f"Failed to parse upload response: {e}")

            if "detail" in api_response:
                error_detail = api_response["detail"]
                raise RuntimeError(f"Upload API error: {error_detail}")

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
                "message": "Content saved and uploaded successfully",
                "execution_time": execution_time,
            }

            logger.info(
                f"[SaveDingTalkContentTool] Success: attachment_id={attachment_id}"
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

            # Cleanup temp directory
            try:
                await sandbox.commands.run(cmd=f"rm -rf {temp_dir}", cwd="/home/user")
            except Exception:
                pass

            return json.dumps(response, ensure_ascii=False, indent=2)

        except Exception as e:
            logger.error(f"[SaveDingTalkContentTool] Error: {e}", exc_info=True)

            error_response = {
                "success": False,
                "attachment_id": None,
                "filename": filename,
                "file_size": 0,
                "download_url": "",
                "error": str(e),
            }

            if self.ws_emitter:
                await self.ws_emitter.emit_tool_call(
                    task_id=self.task_id,
                    tool_name=self.name,
                    tool_input={"filename": filename},
                    status="failed",
                    error=str(e),
                )

            return json.dumps(error_response, ensure_ascii=False, indent=2)
