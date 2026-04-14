# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk Docs Tool Provider.

This module provides the DingTalkDocsToolProvider class that creates
tools for adding DingTalk documents to Wegent knowledge bases.

The tool executes in a sandbox environment to:
1. Download DingTalk document content via MCP
2. Save with naming convention: {title}_{timestamp}.md
3. Upload as attachment
4. Create knowledge base document
"""

import json
import logging
import os
import re
from datetime import datetime
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Default API base URL for attachment uploads
DEFAULT_API_BASE_URL = "http://backend:8000"

# Maximum file size for uploads (100 MB)
MAX_UPLOAD_SIZE = 100 * 1024 * 1024


class DingTalkDocToKBInput(BaseModel):
    """Input schema for dingtalk_doc_to_kb tool."""

    dingtalk_doc_url: str = Field(
        ...,
        description="DingTalk document URL (e.g., https://alidocs.dingtalk.com/i/nodes/xxx)",
    )
    knowledge_base_id: int = Field(
        ...,
        description="Target knowledge base ID",
    )
    doc_title: Optional[str] = Field(
        default=None,
        description="Document title (optional, will be fetched from DingTalk if not provided)",
    )
    trigger_indexing: bool = Field(
        default=True,
        description="Whether to trigger RAG indexing (default: True)",
    )
    trigger_summary: bool = Field(
        default=True,
        description="Whether to trigger summary generation (default: True)",
    )


# Import base class here - use try/except to handle both direct and dynamic loading
try:
    # Try relative import (for direct usage)
    from chat_shell.tools.sandbox._base import BaseSandboxTool
except ImportError:
    # Try absolute import (for dynamic loading)
    import sys

    # Get the package name dynamically
    package_name = __name__.rsplit(".", 1)[0]
    _base_module = sys.modules.get(f"{package_name}._base")
    if _base_module:
        BaseSandboxTool = _base_module.BaseSandboxTool
    else:
        raise ImportError(
            "Cannot import BaseSandboxTool from chat_shell.tools.sandbox._base"
        )


class DingTalkDocsToolProvider:
    """Tool provider for DingTalk Docs operations.

    This provider creates tools that allow Chat Shell agents to add
    DingTalk documents to Wegent knowledge bases.
    """

    @property
    def provider_name(self) -> str:
        """Return the provider name used in SKILL.md."""
        return "dingtalk-docs"

    @property
    def supported_tools(self) -> list[str]:
        """Return the list of tools this provider can create."""
        return ["dingtalk_doc_to_kb"]

    def create_tool(
        self,
        tool_name: str,
        context: Any,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> Any:
        """Create a DingTalk Docs tool instance.

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
            f"[DingTalkDocsProvider] Creating tool: {tool_name}, "
            f"task_id={context.task_id}, user_id={context.user_id}"
        )

        if tool_name == "dingtalk_doc_to_kb":
            return self._create_dingtalk_doc_to_kb_tool(context, tool_config)
        else:
            raise ValueError(f"Unknown tool: {tool_name}")

    def _create_dingtalk_doc_to_kb_tool(
        self, context: Any, tool_config: Optional[dict[str, Any]]
    ) -> "DingTalkDocToKBTool":
        """Create the dingtalk_doc_to_kb tool."""
        config = tool_config or {}

        return DingTalkDocToKBTool(
            task_id=context.task_id,
            subtask_id=context.subtask_id,
            ws_emitter=context.ws_emitter,
            user_id=context.user_id,
            user_name=context.user_name,
            bot_config=config.get("bot_config", []),
            default_shell_type=config.get("default_shell_type", "ClaudeCode"),
            timeout=config.get("timeout", 7200),
            auth_token=context.auth_token,
            skill_identity_token=context.skill_identity_token,
            api_base_url=config.get("api_base_url", ""),
        )

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate DingTalk Docs tool configuration."""
        if not tool_config:
            return True

        # Validate shell_type if present
        shell_type = tool_config.get("default_shell_type")
        if shell_type is not None:
            if shell_type not in ["ClaudeCode", "Agno"]:
                return False

        return True


class DingTalkDocToKBTool(BaseSandboxTool):
    """Tool for adding DingTalk documents to Wegent knowledge base.

    This tool performs the complete workflow:
    1. Starts a sandbox environment
    2. Calls MCP to get document info and content
    3. Saves the document as {title}_{timestamp}.md
    4. Uploads the file as an attachment
    5. Creates a knowledge base document
    """

    name: str = "dingtalk_doc_to_kb"
    display_name: str = "添加钉钉文档到知识库"
    description: str = """Add a DingTalk document to Wegent knowledge base.

This tool downloads a DingTalk document and adds it to a knowledge base.

Workflow:
1. Fetches document info from DingTalk (title, modification time)
2. Downloads document content
3. Saves as {title}_{timestamp}.md (e.g., "产品需求文档_20260413170933.md")
4. Uploads as attachment to Wegent
5. Creates knowledge base document

Parameters:
- dingtalk_doc_url (required): DingTalk document URL
- knowledge_base_id (required): Target knowledge base ID
- doc_title (optional): Document title (fetched from DingTalk if not provided)
- trigger_indexing (optional): Whether to trigger RAG indexing (default: True)
- trigger_summary (optional): Whether to trigger summary generation (default: True)

Returns:
- success: Whether the operation succeeded
- document_id: Created document ID
- document_name: Document name
- attachment_id: Attachment ID
- message: Status message

Example:
{
  "dingtalk_doc_url": "https://alidocs.dingtalk.com/i/nodes/xxx",
  "knowledge_base_id": 123,
  "doc_title": "产品需求文档"
}
"""

    args_schema: type[BaseModel] = DingTalkDocToKBInput

    # Configuration
    max_upload_size: int = MAX_UPLOAD_SIZE
    api_base_url: str = ""

    def _run(
        self,
        dingtalk_doc_url: str,
        knowledge_base_id: int,
        doc_title: Optional[str] = None,
        trigger_indexing: bool = True,
        trigger_summary: bool = True,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Synchronous run - not implemented."""
        raise NotImplementedError("DingTalkDocToKBTool only supports async execution")

    async def _arun(
        self,
        dingtalk_doc_url: str,
        knowledge_base_id: int,
        doc_title: Optional[str] = None,
        trigger_indexing: bool = True,
        trigger_summary: bool = True,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute the DingTalk document to knowledge base workflow.

        Args:
            dingtalk_doc_url: DingTalk document URL
            knowledge_base_id: Target knowledge base ID
            doc_title: Optional document title
            trigger_indexing: Whether to trigger RAG indexing
            trigger_summary: Whether to trigger summary generation
            run_manager: Callback manager

        Returns:
            JSON string with operation result
        """
        logger.info(
            f"[DingTalkDocToKBTool] Starting workflow: url={dingtalk_doc_url}, "
            f"kb_id={knowledge_base_id}"
        )

        # Emit status update
        await self._emit_tool_status(
            "running",
            f"Fetching DingTalk document info: {dingtalk_doc_url}",
        )

        try:
            # Step 1: Get sandbox manager and create sandbox
            sandbox_manager = self._get_sandbox_manager()
            sandbox, error = await sandbox_manager.get_or_create_sandbox(
                shell_type=self.default_shell_type,
                workspace_ref=None,
                task_type="dingtalk-docs",
            )

            if error:
                logger.error(f"[DingTalkDocToKBTool] Failed to create sandbox: {error}")
                result = self._format_error(
                    error_message=f"Failed to create sandbox: {error}",
                )
                await self._emit_tool_status("failed", error)
                return result

            logger.info(f"[DingTalkDocToKBTool] Sandbox created: {sandbox.sandbox_id}")

            # Step 2: Call MCP to get document info
            await self._emit_tool_status(
                "running",
                "Fetching document information from DingTalk...",
            )

            doc_info = await self._get_document_info_from_mcp(sandbox, dingtalk_doc_url)

            if not doc_info.get("success"):
                error_msg = doc_info.get("error", "Failed to get document info")
                logger.error(f"[DingTalkDocToKBTool] {error_msg}")
                result = self._format_error(error_message=error_msg)
                await self._emit_tool_status("failed", error_msg)
                return result

            # Use provided title or fetched title
            title = doc_title or doc_info.get("title", "DingTalk Document")
            modified_time = doc_info.get(
                "modified_time_formatted", self._get_current_timestamp()
            )

            # Step 3: Download document content
            await self._emit_tool_status(
                "running",
                f"Downloading document content: {title}...",
            )

            doc_content_result = await self._download_document_content_real(
                sandbox, dingtalk_doc_url
            )

            if not doc_content_result.get("success"):
                error_msg = doc_content_result.get(
                    "error", "Failed to download document"
                )
                logger.error(f"[DingTalkDocToKBTool] {error_msg}")
                result = self._format_error(error_message=error_msg)
                await self._emit_tool_status("failed", error_msg)
                return result

            content = doc_content_result.get("content", "")

            # Step 4: Save document to sandbox
            filename = self._build_filename(title, modified_time)
            file_path = f"/home/user/{filename}"

            await self._emit_tool_status(
                "running",
                f"Saving document as {filename}...",
            )

            save_result = await self._save_document_to_sandbox(
                sandbox, file_path, content
            )

            if not save_result.get("success"):
                error_msg = save_result.get("error", "Failed to save document")
                logger.error(f"[DingTalkDocToKBTool] {error_msg}")
                result = self._format_error(error_message=error_msg)
                await self._emit_tool_status("failed", error_msg)
                return result

            # Step 5: Upload as attachment
            await self._emit_tool_status(
                "running",
                "Uploading document as attachment...",
            )

            upload_result = await self._upload_attachment(sandbox, file_path)

            if not upload_result.get("success"):
                error_msg = upload_result.get("error", "Failed to upload attachment")
                logger.error(f"[DingTalkDocToKBTool] {error_msg}")
                result = self._format_error(error_message=error_msg)
                await self._emit_tool_status("failed", error_msg)
                return result

            attachment_id = upload_result.get("attachment_id")

            # Step 6: Create knowledge base document
            await self._emit_tool_status(
                "running",
                "Creating knowledge base document...",
            )

            create_result = await self._create_kb_document(
                sandbox,
                knowledge_base_id=knowledge_base_id,
                doc_title=title,
                attachment_id=attachment_id,
                trigger_indexing=trigger_indexing,
                trigger_summary=trigger_summary,
            )

            if not create_result.get("success"):
                error_msg = create_result.get("error", "Failed to create document")
                logger.error(f"[DingTalkDocToKBTool] {error_msg}")
                result = self._format_error(error_message=error_msg)
                await self._emit_tool_status("failed", error_msg)
                return result

            document_id = create_result.get("document_id")

            # Success!
            result = {
                "success": True,
                "document_id": document_id,
                "document_name": title,
                "attachment_id": attachment_id,
                "filename": filename,
                "message": f"Document '{title}' added to knowledge base successfully",
            }

            logger.info(
                f"[DingTalkDocToKBTool] Workflow completed: document_id={document_id}"
            )

            await self._emit_tool_status(
                "completed",
                f"Document '{title}' added to knowledge base successfully",
                result,
            )

            return json.dumps(result, ensure_ascii=False, indent=2)

        except Exception as e:
            logger.error(f"[DingTalkDocToKBTool] Workflow failed: {e}", exc_info=True)
            error_msg = f"Failed to add DingTalk document: {e}"
            result = self._format_error(error_message=error_msg)
            await self._emit_tool_status("failed", error_msg)
            return result

    async def _get_document_info_from_mcp(self, sandbox: Any, doc_url: str) -> dict:
        """Get document info from DingTalk via MCP.

        Calls the dingtalk_docs MCP to get real document metadata.
        """
        try:
            # Extract doc ID from URL
            import re

            doc_id = None
            patterns = [
                r"alidocs\.dingtalk\.com/i/nodes/([a-zA-Z0-9_-]+)",
                r"alidocs\.dingtalk\.com/i/team/[^/]+/docs/([a-zA-Z0-9_-]+)",
                r"alidocs\.dingtalk\.com/i/team/[^/]+/wiki/([a-zA-Z0-9_-]+)",
            ]

            for pattern in patterns:
                match = re.search(pattern, doc_url)
                if match:
                    doc_id = match.group(1)
                    break

            if not doc_id:
                return {
                    "success": False,
                    "error": f"Could not extract document ID from URL: {doc_url}",
                }

            # Call dingtalk_docs MCP via backend API
            api_base_url = self.api_base_url or os.getenv(
                "BACKEND_API_URL", DEFAULT_API_BASE_URL
            )
            api_base_url = api_base_url.rstrip("/")

            auth_token = self.auth_token
            if not auth_token:
                return {
                    "success": False,
                    "error": "No authentication token available",
                }

            mcp_url = f"{api_base_url}/mcp/knowledge/sse"

            # Build MCP tool call payload
            payload = {
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {
                    "name": "get_dingtalk_document_info",
                    "arguments": {"doc_url": doc_url},
                },
                "id": 1,
            }

            # Write payload to a temporary file with unique name
            import uuid

            payload_file = f"/tmp/mcp_payload_{uuid.uuid4().hex}.json"
            payload_json = json.dumps(payload)
            await sandbox.files.write(payload_file, payload_json)

            try:
                # Build curl command using array style
                import shlex

                curl_cmd = [
                    "curl",
                    "-s",
                    "-X",
                    "POST",
                    "-H",
                    f"Authorization: Bearer {auth_token}",
                    "-H",
                    "Content-Type: application/json",
                    "-d",
                    f"@{payload_file}",
                    mcp_url,
                ]

                result_obj = await sandbox.commands.run(
                    cmd=shlex.join(curl_cmd),
                    cwd="/home/user",
                    timeout=60,
                )

                if result_obj.exit_code != 0:
                    return {
                        "success": False,
                        "error": f"MCP call failed: {result_obj.stderr or 'Unknown error'}",
                    }

                # Parse response
                response = json.loads(result_obj.stdout)

                if "error" in response:
                    return {
                        "success": False,
                        "error": response["error"].get("message", "Unknown error"),
                    }

                result_content = response.get("result", {}).get("content", [])
                if result_content:
                    tool_result = json.loads(result_content[0].get("text", "{}"))
                    if tool_result.get("success"):
                        return {
                            "success": True,
                            "doc_id": tool_result.get("doc_id", doc_id),
                            "title": tool_result.get(
                                "title", f"DingTalkDoc_{doc_id[:8]}"
                            ),
                            "modified_time": tool_result.get(
                                "modified_time", datetime.now().isoformat()
                            ),
                            "modified_time_formatted": tool_result.get(
                                "modified_time_formatted",
                                datetime.now().strftime("%Y%m%d%H%M%S"),
                            ),
                        }
                    else:
                        return {
                            "success": False,
                            "error": tool_result.get("error", "Unknown error"),
                        }

                return {"success": False, "error": "Empty response from MCP"}

            finally:
                # Clean up temp file
                try:
                    await sandbox.commands.run(
                        cmd=f"rm -f {payload_file}",
                        cwd="/home/user",
                        timeout=10,
                    )
                except Exception:
                    pass

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _download_document_content(self, sandbox: Any, doc_url: str) -> dict:
        """Download document content from DingTalk.

        For now, this returns placeholder content.
        In production, this would call the DingTalk API via MCP.
        """
        try:
            # Extract doc ID for content generation
            import re

            doc_id = None
            patterns = [
                r"alidocs\.dingtalk\.com/i/nodes/([a-zA-Z0-9_-]+)",
                r"alidocs\.dingtalk\.com/i/team/[^/]+/docs/([a-zA-Z0-9_-]+)",
            ]

            for pattern in patterns:
                match = re.search(pattern, doc_url)
                if match:
                    doc_id = match.group(1)
                    break

            # Generate placeholder content
            content = f"""# DingTalk Document

This document was imported from DingTalk.

**Source URL:** {doc_url}
**Document ID:** {doc_id or "unknown"}
**Imported at:** {datetime.now().isoformat()}

## Content

The actual content would be fetched from DingTalk API in production.
This is a placeholder for the document content.

---
*Imported by Wegent DingTalk Docs Skill*
"""

            return {"success": True, "content": content}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _download_document_content_real(self, sandbox: Any, doc_url: str) -> dict:
        """Download document content from DingTalk via MCP.

        Calls the dingtalk_docs MCP to get real document content.
        """
        try:
            # Extract doc ID from URL
            import re

            doc_id = None
            patterns = [
                r"alidocs\.dingtalk\.com/i/nodes/([a-zA-Z0-9_-]+)",
                r"alidocs\.dingtalk\.com/i/team/[^/]+/docs/([a-zA-Z0-9_-]+)",
            ]

            for pattern in patterns:
                match = re.search(pattern, doc_url)
                if match:
                    doc_id = match.group(1)
                    break

            if not doc_id:
                return {
                    "success": False,
                    "error": f"Could not extract document ID from URL: {doc_url}",
                }

            # Call dingtalk_docs MCP via backend API
            api_base_url = self.api_base_url or os.getenv(
                "BACKEND_API_URL", DEFAULT_API_BASE_URL
            )
            api_base_url = api_base_url.rstrip("/")

            auth_token = self.auth_token
            if not auth_token:
                return {
                    "success": False,
                    "error": "No authentication token available",
                }

            mcp_url = f"{api_base_url}/mcp/knowledge/sse"

            # Build MCP tool call payload for download_document
            payload = {
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {
                    "name": "download_document",
                    "arguments": {
                        "doc_id": doc_id,
                        "url": doc_url,
                        "format": "markdown",
                    },
                },
                "id": 1,
            }

            # Write payload to a temporary file with unique name
            import uuid

            payload_file = f"/tmp/mcp_download_payload_{uuid.uuid4().hex}.json"
            payload_json = json.dumps(payload)
            await sandbox.files.write(payload_file, payload_json)

            try:
                # Build curl command using array style
                import shlex

                curl_cmd = [
                    "curl",
                    "-s",
                    "-X",
                    "POST",
                    "-H",
                    f"Authorization: Bearer {auth_token}",
                    "-H",
                    "Content-Type: application/json",
                    "-d",
                    f"@{payload_file}",
                    mcp_url,
                ]

                result_obj = await sandbox.commands.run(
                    cmd=shlex.join(curl_cmd),
                    cwd="/home/user",
                    timeout=120,  # Longer timeout for download
                )

                if result_obj.exit_code != 0:
                    return {
                        "success": False,
                        "error": f"MCP download failed: {result_obj.stderr or 'Unknown error'}",
                    }

                # Parse response
                response = json.loads(result_obj.stdout)

                if "error" in response:
                    return {
                        "success": False,
                        "error": response["error"].get("message", "Unknown error"),
                    }

                result_content = response.get("result", {}).get("content", [])
                if result_content:
                    tool_result = json.loads(result_content[0].get("text", "{}"))
                    if tool_result.get("success"):
                        content = tool_result.get("content", "")
                        if not content:
                            return {
                                "success": False,
                                "error": "Empty content returned from DingTalk",
                            }
                        return {"success": True, "content": content}
                    else:
                        return {
                            "success": False,
                            "error": tool_result.get("error", "Unknown error"),
                        }

                return {"success": False, "error": "Empty response from MCP"}

            finally:
                # Clean up temp file
                try:
                    await sandbox.commands.run(
                        cmd=f"rm -f {payload_file}",
                        cwd="/home/user",
                        timeout=10,
                    )
                except Exception:
                    pass

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _save_document_to_sandbox(
        self, sandbox: Any, file_path: str, content: str
    ) -> dict:
        """Save document content to sandbox file."""
        try:
            # Write content to file in sandbox
            await sandbox.files.write(file_path, content)
            return {"success": True, "file_path": file_path}
        except Exception as e:
            return {"success": False, "error": f"Failed to save file: {e}"}

    async def _upload_attachment(self, sandbox: Any, file_path: str) -> dict:
        """Upload file from sandbox as attachment."""
        try:
            # Get API base URL and auth token
            api_base_url = self.api_base_url or os.getenv(
                "BACKEND_API_URL", DEFAULT_API_BASE_URL
            )
            api_base_url = api_base_url.rstrip("/")

            auth_token = self.auth_token
            if not auth_token:
                return {
                    "success": False,
                    "error": "No authentication token available for upload",
                }

            upload_url = f"{api_base_url}/api/attachments/upload"

            # Build curl command with shlex.quote to prevent shell injection
            import shlex

            curl_cmd = [
                "curl",
                "-s",
                "-X",
                "POST",
                "-H",
                f"Authorization: Bearer {auth_token}",
                "-F",
                f"file=@{file_path}",
                upload_url,
            ]

            # Execute curl command (pass as list to avoid shell interpretation)
            result_obj = await sandbox.commands.run(
                cmd=shlex.join(curl_cmd),
                cwd="/home/user",
                timeout=300,
            )

            if result_obj.exit_code != 0:
                return {
                    "success": False,
                    "error": f"Upload failed: {result_obj.stderr or 'Unknown error'}",
                }

            # Parse JSON response
            api_response = json.loads(result_obj.stdout)

            if "detail" in api_response:
                error_detail = api_response["detail"]
                error_msg = (
                    error_detail.get("message", str(error_detail))
                    if isinstance(error_detail, dict)
                    else str(error_detail)
                )
                return {"success": False, "error": f"Upload API error: {error_msg}"}

            attachment_id = api_response.get("id")
            if not attachment_id:
                return {"success": False, "error": "No attachment ID in response"}

            return {"success": True, "attachment_id": attachment_id}

        except json.JSONDecodeError as e:
            return {"success": False, "error": f"Failed to parse upload response: {e}"}
        except Exception as e:
            return {"success": False, "error": f"Upload failed: {e}"}

    async def _create_kb_document(
        self,
        sandbox: Any,
        knowledge_base_id: int,
        doc_title: str,
        attachment_id: int,
        trigger_indexing: bool,
        trigger_summary: bool,
    ) -> dict:
        """Create knowledge base document using MCP."""
        try:
            # Get API base URL and auth token
            api_base_url = self.api_base_url or os.getenv(
                "BACKEND_API_URL", DEFAULT_API_BASE_URL
            )
            api_base_url = api_base_url.rstrip("/")

            auth_token = self.auth_token
            if not auth_token:
                return {
                    "success": False,
                    "error": "No authentication token available",
                }

            # Call the add_dingtalk_doc_with_attachment MCP tool via API
            # Since we can't directly call MCP from sandbox, we use the knowledge API
            mcp_url = f"{api_base_url}/mcp/knowledge/sse"

            # Build the tool call payload
            payload = {
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {
                    "name": "add_dingtalk_doc_with_attachment",
                    "arguments": {
                        "knowledge_base_id": knowledge_base_id,
                        "doc_title": doc_title,
                        "attachment_id": attachment_id,
                        "trigger_indexing": trigger_indexing,
                        "trigger_summary": trigger_summary,
                    },
                },
                "id": 1,
            }

            # Write payload to a temporary file with unique name to avoid race conditions
            import uuid

            payload_file = f"/tmp/mcp_payload_{uuid.uuid4().hex}.json"
            payload_json = json.dumps(payload)
            await sandbox.files.write(payload_file, payload_json)

            try:
                # Build curl command using array style to prevent shell injection
                import shlex

                curl_cmd = [
                    "curl",
                    "-s",
                    "-X",
                    "POST",
                    "-H",
                    f"Authorization: Bearer {auth_token}",
                    "-H",
                    "Content-Type: application/json",
                    "-d",
                    f"@{payload_file}",
                    mcp_url,
                ]

                result_obj = await sandbox.commands.run(
                    cmd=shlex.join(curl_cmd),
                    cwd="/home/user",
                    timeout=60,
                )

                # Clean up temp file after use
                try:
                    await sandbox.commands.run(
                        cmd=f"rm -f {payload_file}",
                        cwd="/home/user",
                        timeout=10,
                    )
                except Exception:
                    pass

            except Exception as e:
                # Clean up temp file on error
                try:
                    await sandbox.commands.run(
                        cmd=f"rm -f {payload_file}",
                        cwd="/home/user",
                        timeout=10,
                    )
                except Exception:
                    pass
                raise e

            if result_obj.exit_code != 0:
                return {
                    "success": False,
                    "error": f"MCP call failed: {result_obj.stderr or 'Unknown error'}",
                }

            # Parse response
            response = json.loads(result_obj.stdout)

            if "error" in response:
                return {
                    "success": False,
                    "error": response["error"].get("message", "Unknown error"),
                }

            result_content = response.get("result", {}).get("content", [])
            if result_content:
                tool_result = json.loads(result_content[0].get("text", "{}"))
                if tool_result.get("success"):
                    return {
                        "success": True,
                        "document_id": tool_result.get("document_id"),
                    }
                else:
                    return {
                        "success": False,
                        "error": tool_result.get("error", "Unknown error"),
                    }

            return {"success": False, "error": "Empty response from MCP"}

        except json.JSONDecodeError as e:
            return {"success": False, "error": f"Failed to parse MCP response: {e}"}
        except Exception as e:
            return {"success": False, "error": f"Failed to create document: {e}"}

    def _build_filename(self, title: str, modified_time: str) -> str:
        """Build filename according to naming convention.

        Format: {title}_{timestamp}.md
        Example: 产品需求文档_20260413170933.md
        """
        # Use shared utility function to avoid duplication
        try:
            from app.services.dingtalk import build_dingtalk_doc_filename

            return build_dingtalk_doc_filename(title, modified_time)
        except ImportError:
            # Fallback if import fails (e.g., during skill loading)
            import re

            safe_title = re.sub(r'[<>:"/\\|?*]', "_", title)
            safe_title = safe_title.strip()
            if not safe_title:
                safe_title = "untitled"
            return f"{safe_title}_{modified_time}.md"

    def _get_current_timestamp(self) -> str:
        """Get current timestamp in YYYYMMDDHHMMSS format."""
        return datetime.now().strftime("%Y%m%d%H%M%S")
