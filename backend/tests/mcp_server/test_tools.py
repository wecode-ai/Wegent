# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP Server tools."""

import importlib
import inspect
import json
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from mcp.server.fastmcp import FastMCP

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tool_registry import _register_tool


def get_silent_exit_module():
    """Get the silent_exit module, handling import caching issues."""
    module_name = "app.mcp_server.tools.silent_exit"
    # Force import the module directly
    if module_name not in sys.modules:
        importlib.import_module(module_name)
    return sys.modules[module_name]


def get_knowledge_module():
    """Get the knowledge module, handling import caching issues."""
    module_name = "app.mcp_server.tools.knowledge"
    if module_name not in sys.modules:
        importlib.import_module(module_name)
    return sys.modules[module_name]


class TestSilentExitTool:
    """Tests for silent_exit tool."""

    def test_silent_exit_returns_marker(self):
        """Test that silent_exit returns the correct marker without token_info."""
        module = get_silent_exit_module()
        # When token_info is None, no database access is needed
        result = module.silent_exit(reason="test reason")
        parsed = json.loads(result)

        assert parsed["__silent_exit__"] is True
        assert parsed["reason"] == "test reason"

    def test_silent_exit_empty_reason(self):
        """Test silent_exit with empty reason."""
        module = get_silent_exit_module()
        # When token_info is None, no database access is needed
        result = module.silent_exit()
        parsed = json.loads(result)

        assert parsed["__silent_exit__"] is True
        assert parsed["reason"] == ""

    def test_silent_exit_with_token_info(self):
        """Test silent_exit with token info - verifies marker is returned."""
        module = get_silent_exit_module()

        token_info = TaskTokenInfo(
            task_id=123,
            subtask_id=456,
            user_id=789,
            user_name="testuser",
        )

        # Use object patching instead of string-based patching
        original_func = module._update_subtask_silent_exit
        mock_update = MagicMock()
        module._update_subtask_silent_exit = mock_update

        try:
            result = module.silent_exit(reason="completed", token_info=token_info)

            # Should attempt to update the database
            mock_update.assert_called_once_with(456, "completed")

            parsed = json.loads(result)
            assert parsed["__silent_exit__"] is True
            assert parsed["reason"] == "completed"
        finally:
            # Restore original function
            module._update_subtask_silent_exit = original_func


class TestSilentExitMarkerDetection:
    """Tests for detecting silent_exit marker in responses."""

    def test_detect_silent_exit_marker(self):
        """Test detection of __silent_exit__ marker in tool output."""
        tool_output = json.dumps({"__silent_exit__": True, "reason": "normal status"})

        parsed = json.loads(tool_output)
        assert parsed.get("__silent_exit__") is True
        assert parsed.get("reason") == "normal status"

    def test_non_silent_exit_output(self):
        """Test that normal output doesn't trigger false positive."""
        tool_output = json.dumps({"success": True, "data": "some data"})

        parsed = json.loads(tool_output)
        assert parsed.get("__silent_exit__") is not True

    def test_invalid_json_output(self):
        """Test handling of non-JSON output."""
        tool_output = "plain text output"

        try:
            parsed = json.loads(tool_output)
            is_silent = parsed.get("__silent_exit__")
        except json.JSONDecodeError:
            is_silent = False

        assert is_silent is False


class TestKnowledgeTool:
    """Tests for knowledge MCP tools."""

    def test_knowledge_mcp_tools_registry_contains_registered_tools(self):
        """Test that the backward-compatible tool registry is built for the knowledge server."""
        module = get_knowledge_module()

        assert "wegent_kb_list_knowledge_bases" in module.KNOWLEDGE_MCP_TOOLS
        assert "wegent_kb_list_documents" in module.KNOWLEDGE_MCP_TOOLS
        assert "wegent_kb_read_document_content" in module.KNOWLEDGE_MCP_TOOLS
        assert "wegent_kb_get_document_download" in module.KNOWLEDGE_MCP_TOOLS

    def test_get_document_download_returns_short_lived_credentials(self):
        """Test that get_document_download returns source-file download credentials."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )
        mock_session = MagicMock()
        mock_session.query.return_value.filter.return_value.scalar.return_value = 77
        mock_user = SimpleNamespace(id=3)
        access = MagicMock(
            downloadable=True,
            previewable=False,
            knowledge_base_id=77,
            mime_type=(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ),
            file_name="report.xlsx",
            file_extension="xlsx",
            file_size=1234,
        )

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(
                module,
                "_get_read_user_for_knowledge_base",
                return_value=mock_user,
            ) as mock_get_read_user,
            patch.object(
                module,
                "get_document_file_or_raise",
                return_value=access,
            ) as mock_get_access,
            patch.object(
                module,
                "create_document_download_token",
                return_value="download-token",
            ) as mock_create_download_token,
        ):
            result = module.get_document_download(
                token_info=token_info,
                document_id=9,
            )

        assert result["document_id"] == 9
        assert result["knowledge_base_id"] == 77
        assert result["resource_url"] == "/api/mcp/knowledge-external/documents/9/file"
        assert result["headers"] == {module.DOWNLOAD_TOKEN_HEADER: "download-token"}
        assert result["disposition"] == "attachment"
        assert result["file_name"] == "report.xlsx"
        assert result["download_dir"] == "/home/user/1:executor:knowledge/2"
        assert result["local_path"] == "/home/user/1:executor:knowledge/2/report.xlsx"
        assert "${TASK_API_DOMAIN%/}" in result["download_command"]
        assert "download-token" in result["download_command"]
        assert "/home/user/1:executor:knowledge/2" in result["download_command"]
        assert 'mkdir -p "$download_dir"' in result["download_command"]
        assert '-o "$output_path"' in result["download_command"]
        mock_get_read_user.assert_called_once_with(mock_session, token_info, 77)
        mock_get_access.assert_called_once_with(
            mock_session,
            user_id=3,
            document_id=9,
            disposition="attachment",
        )
        mock_create_download_token.assert_called_once_with(
            user_id=3,
            document_id=9,
            disposition="attachment",
        )
        mock_session.close.assert_called_once()

    def test_get_document_download_does_not_issue_token_when_download_is_disabled(
        self,
    ):
        """Protected knowledge bases must be rejected before token issuance."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )
        mock_session = MagicMock()
        mock_session.query.return_value.filter.return_value.scalar.return_value = 77

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(
                module,
                "_get_read_user_for_knowledge_base",
                return_value=SimpleNamespace(id=3),
            ),
            patch.object(
                module,
                "get_document_file_or_raise",
                side_effect=module.ExternalDocumentAccessError(
                    "Document download is disabled",
                    "DOCUMENT_DOWNLOAD_DISABLED",
                ),
            ),
            patch.object(module, "create_document_download_token") as mock_create_token,
        ):
            result = module.get_document_download(
                token_info=token_info,
                document_id=9,
            )

        assert result == {
            "error": "Document download is disabled",
            "code": "DOCUMENT_DOWNLOAD_DISABLED",
        }
        mock_create_token.assert_not_called()
        mock_session.close.assert_called_once()

    def test_download_command_sanitizes_output_file_name(self):
        """Test that generated curl commands cannot write to path traversal names."""
        module = get_knowledge_module()

        command = module._build_download_command(
            resource_url="/api/mcp/knowledge-external/documents/9/file",
            token="download-token",
            file_name="../../etc/cron.d/malicious",
        )

        assert "-o 'malicious'" in command
        assert "../../etc/cron.d/malicious" not in command

    def test_download_command_uses_executor_private_directory_when_task_scoped(self):
        """Test that task-scoped download commands avoid writing to task files."""
        module = get_knowledge_module()

        command = module._build_download_command(
            resource_url="/api/mcp/knowledge-external/documents/9/file",
            token="download-token",
            file_name="../../etc/cron.d/malicious",
            task_id=1,
            subtask_id=2,
        )

        assert "/home/user/1:executor:knowledge/2" in command
        assert 'output_path="$download_dir"/' in command
        assert "'malicious'" in command
        assert "../../etc/cron.d/malicious" not in command

    def test_download_command_falls_back_for_unsafe_empty_basename(self):
        """Test that unsafe empty basenames use a stable fallback output name."""
        module = get_knowledge_module()

        command = module._build_download_command(
            resource_url="/api/mcp/knowledge-external/documents/9/file",
            token="download-token",
            file_name="../..",
        )

        assert "-o 'document'" in command

    @pytest.mark.asyncio
    async def test_search_knowledge_base_publishes_search_hints_schema(self) -> None:
        """The MCP schema must expose exactly the supported hint fields."""
        module = get_knowledge_module()
        server = FastMCP("schema-check")
        tool_info = module.search_knowledge_base._mcp_tool_info
        _register_tool(server, tool_info, "knowledge")

        tool = next(
            item
            for item in await server.list_tools()
            if item.name == "wegent_kb_search_knowledge_base"
        )
        schema = tool.inputSchema["$defs"]["SearchHints"]

        assert schema["additionalProperties"] is False
        assert set(schema["properties"]) == {
            "semantic_query",
            "keywords",
            "phrases",
        }

    @pytest.mark.asyncio
    async def test_search_knowledge_base_rejects_unknown_search_hint_fields(
        self,
    ) -> None:
        """Invalid hints must stop at the MCP boundary before runtime resolution."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1, subtask_id=2, user_id=3, user_name="alice"
        )

        result = await module.search_knowledge_base(
            token_info=token_info,
            knowledge_base_id=7,
            query="how to disable an experiment",
            search_hints={"exact_keywords": ["experiment", "disable"]},
        )

        assert "Invalid search_hints" in result["error"]
        assert "exact_keywords" in result["error"]
        assert result["chunks"] == []
        assert result["sources"] == []
        assert result["total"] == 0

    def test_list_documents_passes_optional_query_params(self):
        """list_documents should pass backward-compatible optional query params."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1, subtask_id=2, user_id=3, user_name="alice"
        )
        mock_session = MagicMock()
        user = SimpleNamespace(id=3)
        response = SimpleNamespace(
            total=1,
            returned_count=1,
            limit=10,
            offset=0,
            has_more=False,
            items=[SimpleNamespace(model_dump=lambda: {"id": 9})],
        )

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(
                module.KnowledgeService,
                "resolve_read_user_for_knowledge_base",
                return_value=user,
            ),
            patch.object(
                module.knowledge_orchestrator, "list_documents", return_value=response
            ) as mock_list,
        ):
            result = module.list_documents(
                token_info=token_info,
                knowledge_base_id=7,
                folder_id=5,
                include_subfolders=True,
                keyword="report",
                sort_by="name",
                sort_order="asc",
                limit=10,
                offset=0,
            )

        mock_list.assert_called_once_with(
            db=mock_session,
            user=user,
            knowledge_base_id=7,
            folder_id=5,
            limit=10,
            offset=0,
            include_subfolders=True,
            keyword="report",
            sort_by="name",
            sort_order="asc",
        )
        assert result["items"] == [{"id": 9}]

    def test_list_documents_includes_descendants_by_default(self):
        """Folder listings should include descendant folders by default."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1, subtask_id=2, user_id=3, user_name="alice"
        )
        mock_session = MagicMock()
        user = SimpleNamespace(id=3)
        response = SimpleNamespace(
            total=0,
            returned_count=0,
            limit=50,
            offset=0,
            has_more=False,
            items=[],
        )

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(
                module.KnowledgeService,
                "resolve_read_user_for_knowledge_base",
                return_value=user,
            ),
            patch.object(
                module.knowledge_orchestrator, "list_documents", return_value=response
            ) as mock_list,
        ):
            module.list_documents(
                token_info=token_info,
                knowledge_base_id=7,
                folder_id=5,
            )

        assert mock_list.call_args.kwargs["folder_id"] == 5
        assert mock_list.call_args.kwargs["include_subfolders"] is True

    def test_list_documents_returns_error_for_invalid_folder_scope(self):
        """list_documents should expose invalid folder scope errors."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1, subtask_id=2, user_id=3, user_name="alice"
        )
        mock_session = MagicMock()
        user = SimpleNamespace(id=3)

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(
                module.KnowledgeService,
                "resolve_read_user_for_knowledge_base",
                return_value=user,
            ),
            patch.object(
                module.knowledge_orchestrator,
                "list_documents",
                side_effect=ValueError("Folder not found in this knowledge base"),
            ),
        ):
            result = module.list_documents(
                token_info=token_info,
                knowledge_base_id=7,
                folder_id=999,
            )

        assert result == {
            "error": "Folder not found in this knowledge base",
            "total": 0,
            "items": [],
        }
        mock_session.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_search_knowledge_base_passes_raw_scope(self):
        """search_knowledge_base should delegate raw scope to the orchestrator."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1, subtask_id=2, user_id=3, user_name="alice"
        )

        async def fake_retrieve(**kwargs):
            return {
                "query": kwargs["query"],
                "records": [],
                "total": 0,
                "mode": "rag_retrieval",
            }

        with (
            patch.object(
                module.knowledge_orchestrator,
                "retrieve_knowledge",
                side_effect=fake_retrieve,
            ) as mock_retrieve,
        ):
            result = await module.search_knowledge_base(
                token_info=token_info,
                knowledge_base_id=7,
                query="policy",
                max_results=5,
                document_ids=[11],
                folder_ids=[5],
                include_subfolders=False,
            )

        mock_retrieve.assert_called_once()
        assert mock_retrieve.call_args.kwargs["user_id"] == 3
        assert mock_retrieve.call_args.kwargs["task_id"] == 1
        assert mock_retrieve.call_args.kwargs["document_ids"] == [11]
        assert mock_retrieve.call_args.kwargs["folder_ids"] == [5]
        assert mock_retrieve.call_args.kwargs["include_subfolders"] is False
        assert result["query"] == "policy"

    def test_read_document_content_returns_orchestrator_payload(self):
        """Test that read_document_content returns the orchestrator payload."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )
        mock_user = object()
        mock_session = MagicMock()
        mock_result = MagicMock(
            document_id=9,
            name="roadmap",
            content="abcd",
            total_length=10,
            offset=0,
            returned_length=4,
            has_more=True,
            kb_id=77,
        )
        expected_payload = {
            "document_id": 9,
            "name": "roadmap",
            "content": "abcd",
            "total_length": 10,
            "offset": 0,
            "returned_length": 4,
            "has_more": True,
            "kb_id": 77,
        }
        mock_result.model_dump.return_value = expected_payload
        mock_session.query.return_value.filter.return_value.scalar.return_value = 77

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(
                module,
                "_get_read_user_for_knowledge_base",
                return_value=mock_user,
            ) as mock_get_read_user,
            patch.object(
                module.knowledge_orchestrator,
                "read_document_content",
                return_value=mock_result,
            ) as mock_read,
        ):
            result = module.read_document_content(
                token_info=token_info,
                document_id=9,
                offset=0,
                limit=4,
            )

        assert result == expected_payload
        mock_get_read_user.assert_called_once_with(
            mock_session,
            token_info,
            77,
        )
        mock_read.assert_called_once_with(
            db=mock_session,
            user=mock_user,
            document_id=9,
            offset=0,
            limit=4,
        )
        mock_session.close.assert_called_once()

    def test_read_document_content_returns_error_dict_for_validation_failure(self):
        """Test that read_document_content converts validation failures to error dicts."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )
        mock_user = object()
        mock_session = MagicMock()
        mock_session.query.return_value.filter.return_value.scalar.return_value = 77

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(
                module,
                "_get_read_user_for_knowledge_base",
                return_value=mock_user,
            ),
            patch.object(
                module.knowledge_orchestrator,
                "read_document_content",
                side_effect=ValueError("limit must be greater than 0"),
            ),
        ):
            result = module.read_document_content(
                token_info=token_info,
                document_id=9,
                offset=0,
                limit=0,
            )

        assert result == {"error": "limit must be greater than 0"}
        mock_session.close.assert_called_once()

    def test_read_document_content_returns_error_dict_for_unexpected_failure(self):
        """Test that read_document_content converts unexpected failures to error dicts."""
        module = get_knowledge_module()
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="alice",
        )
        mock_user = object()
        mock_session = MagicMock()
        mock_session.query.return_value.filter.return_value.scalar.return_value = 77

        with (
            patch.object(module, "SessionLocal", return_value=mock_session),
            patch.object(
                module,
                "_get_read_user_for_knowledge_base",
                return_value=mock_user,
            ),
            patch.object(
                module.knowledge_orchestrator,
                "read_document_content",
                side_effect=RuntimeError("boom"),
            ),
        ):
            result = module.read_document_content(
                token_info=token_info,
                document_id=9,
            )

        assert result == {"error": "boom"}
        mock_session.close.assert_called_once()

    def test_read_document_content_uses_shared_default_limit_constant(self):
        """Test that read_document_content reuses the shared default limit constant."""
        module = get_knowledge_module()
        target = getattr(
            module.read_document_content,
            "__wrapped__",
            module.read_document_content,
        )
        default_limit = inspect.signature(target).parameters["limit"].default

        assert default_limit == module.MAX_DOCUMENT_READ_LIMIT

    def test_update_document_content_description_mentions_editable_text_files(self):
        """Tool description should reflect support for editable text file documents."""
        module = get_knowledge_module()

        tool_info = module.update_document_content._mcp_tool_info

        assert "TEXT type documents" not in tool_info["description"]
        assert (
            "plain-text" in tool_info["description"].lower()
            or "text" in tool_info["description"].lower()
        )
